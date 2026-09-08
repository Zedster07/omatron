# The only Python that ever runs inside Blender for this plugin.
#
# It is SHIPPED, not generated. Operations arrive as JSON on argv and are
# dispatched through the table below; nothing here ever exec()s or eval()s a
# string it was handed. That distinction is the whole design.
#
# The alternative -- letting the agent send bpy code, or running
# `blender --python <file it wrote>` -- would be handing it a Python
# interpreter running as the user, with os and subprocess in scope. The policy
# denies python3, node, bun and sh by name for exactly that reason, and a
# Blender that takes arbitrary scripts is those commands wearing a hat.
#
# So the agent names an operation and gives numbers. Anything it can do here is
# something this file already knew how to do.
import bpy
import json
import mathutils
import math
import os
import sys


def _args():
    i = sys.argv.index("--")
    return sys.argv[i + 1], json.loads(sys.argv[i + 2])


def _obj(name):
    o = bpy.data.objects.get(name)
    if o is None:
        raise ValueError(f"no object named {name!r}; the scene has: "
                         + ", ".join(o.name for o in bpy.data.objects) or "(nothing)")
    return o


def _vec(v, default=(0.0, 0.0, 0.0)):
    if v is None:
        return default
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        raise ValueError("expected three numbers, e.g. [0, 0, 1]")
    return tuple(float(x) for x in v)


# Blender spells the size of every primitive differently -- size for a cube,
# radius for a sphere, major_radius for a torus -- so one uniform "size" is
# translated here rather than asked of the caller.
def op_add(o):
    prim = o.get("primitive", "cube")
    size = float(o.get("size", 2.0))
    at = _vec(o.get("at"))
    rot = tuple(math.radians(a) for a in _vec(o.get("rotation_deg")))
    common = dict(location=at, rotation=rot)

    if prim == "cube":
        bpy.ops.mesh.primitive_cube_add(size=size, **common)
    elif prim == "plane":
        bpy.ops.mesh.primitive_plane_add(size=size, **common)
    elif prim == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 2, **common)
    elif prim == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=size / 2,
                                            depth=float(o.get("depth", size)), **common)
    elif prim == "cone":
        bpy.ops.mesh.primitive_cone_add(radius1=size / 2,
                                        radius2=float(o.get("radius_top", 0.0)),
                                        depth=float(o.get("depth", size)), **common)
    elif prim == "torus":
        bpy.ops.mesh.primitive_torus_add(major_radius=size / 2,
                                         minor_radius=float(o.get("thickness", size / 8)),
                                         **common)
    else:
        raise ValueError(f"unknown primitive {prim!r}")

    if o.get("name"):
        bpy.context.active_object.name = str(o["name"])
    return bpy.context.active_object.name


def op_transform(o):
    ob = _obj(o["name"])
    if "at" in o:
        ob.location = _vec(o["at"])
    if "move_by" in o:
        d = _vec(o["move_by"])
        ob.location = tuple(ob.location[i] + d[i] for i in range(3))
    if "rotation_deg" in o:
        ob.rotation_euler = tuple(math.radians(a) for a in _vec(o["rotation_deg"]))
    if "scale" in o:
        s = o["scale"]
        ob.scale = _vec(s) if isinstance(s, (list, tuple)) else (float(s),) * 3
    return ob.name


def op_modifier(o):
    ob = _obj(o["name"])
    kind = o.get("kind")
    if kind == "boolean":
        m = ob.modifiers.new(name="Boolean", type="BOOLEAN")
        m.object = _obj(o["with"])
        m.operation = o.get("mode", "DIFFERENCE").upper()
    elif kind == "array":
        # Linear only. A radial pattern -- a bolt circle, spokes -- is not this
        # modifier's job without an empty to orbit, so rather than half-support
        # it, say so: computing N positions and adding N objects is something a
        # caller does well and this cannot fake.
        m = ob.modifiers.new(name="Array", type="ARRAY")
        m.count = int(o.get("count", 2))
        off = _vec(o.get("offset"), (1.0, 0.0, 0.0))
        if off == (0.0, 0.0, 0.0):
            raise ValueError(
                "array with a zero offset stacks every copy in one place. For a straight "
                "repeat give an offset; for a ring, add the objects at computed positions "
                "instead -- this modifier does not do radial patterns.")
        m.relative_offset_displace = off
    elif kind == "bevel":
        m = ob.modifiers.new(name="Bevel", type="BEVEL")
        m.width = float(o.get("width", 0.1))
        m.segments = int(o.get("segments", 2))
    elif kind == "subdivide":
        m = ob.modifiers.new(name="Subdivision", type="SUBSURF")
        m.levels = m.render_levels = int(o.get("levels", 2))
    elif kind == "mirror":
        # Model one side and let the modifier own the other. The first car had
        # Wheel1..Wheel4 placed by hand, which is four chances to typo a
        # coordinate and no guarantee the halves match. A mirror cannot drift.
        m = ob.modifiers.new(name="Mirror", type="MIRROR")
        axes = o.get("axis", "x")
        axes = axes if isinstance(axes, (list, tuple)) else [axes]
        m.use_axis = tuple("xyz"[i] in [str(a).lower() for a in axes] for i in range(3))
        m.use_clip = bool(o.get("clip", True))

        # Mirror about the WORLD origin by default, not the object's own.
        #
        # Blender's default is the object origin, and every part this API
        # creates is placed by setting location -- so a wheel added at x=1.36
        # has a mesh symmetric about its own origin, and mirroring it produces
        # exactly nothing. Silently. That is the array-with-zero-offset trap
        # again: an operation that reports success and changes no geometry.
        #
        # "Mirror the wheel" means "put one on the other side", so that is what
        # it does. Pass `about` to mirror around some other object instead.
        if o.get("about"):
            m.mirror_object = _obj(o["about"])
        else:
            origin = bpy.data.objects.get("MirrorOrigin")
            if origin is None:
                origin = bpy.data.objects.new("MirrorOrigin", None)
                origin.empty_display_size = 0.01
                bpy.context.scene.collection.objects.link(origin)
                origin.hide_render = True
            m.mirror_object = origin
    elif kind == "weighted_normal":
        # Makes bevelled edges read correctly instead of smearing shading
        # across the face they belong to.
        ob.data.use_auto_smooth = True if hasattr(ob.data, "use_auto_smooth") else None
        m = ob.modifiers.new(name="WeightedNormal", type="WEIGHTED_NORMAL")
        m.keep_sharp = True
    elif kind == "solidify":
        m = ob.modifiers.new(name="Solidify", type="SOLIDIFY")
        m.thickness = float(o.get("thickness", 0.1))
    else:
        raise ValueError(f"unknown modifier {kind!r}")
    return f"{ob.name}: {m.type}"


def op_apply_modifiers(o):
    ob = _obj(o["name"])
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    return ob.name


def op_delete(o):
    ob = _obj(o["name"])
    bpy.data.objects.remove(ob, do_unlink=True)
    return o["name"]


def op_rename(o):
    ob = _obj(o["name"])
    ob.name = str(o["to"])
    return ob.name


def op_material(o):
    ob = _obj(o["name"])
    mat = bpy.data.materials.new(name=o.get("material", "Material"))
    mat.use_nodes = True
    c = o.get("color", [0.8, 0.8, 0.8])
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (float(c[0]), float(c[1]), float(c[2]), 1.0)
        if "roughness" in o:
            bsdf.inputs["Roughness"].default_value = float(o["roughness"])
        if "metallic" in o:
            bsdf.inputs["Metallic"].default_value = float(o["metallic"])
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return f"{ob.name}: {mat.name}"



def op_mesh(o):
    """Build an object from explicit vertices and faces.

    The op set started as primitives plus modifiers, which assembles shapes but
    does not model: a cube and four cylinders is a bill of materials, and
    bevelling it does not make it geometry. This is the missing primitive --
    real vertices, in the positions the caller worked out.
    """
    verts = [tuple(float(c) for c in v) for v in o["verts"]]
    faces = [tuple(int(i) for i in f) for f in o.get("faces", [])]
    for f in faces:
        for i in f:
            if i < 0 or i >= len(verts):
                raise ValueError(f"face references vertex {i}, but there are only {len(verts)}")

    me = bpy.data.meshes.new(o.get("name", "Mesh"))
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    ob = bpy.data.objects.new(o.get("name", "Mesh"), me)
    bpy.context.collection.objects.link(ob)
    ob.location = _vec(o.get("at"))
    if o.get("shade") == "smooth":
        for poly in me.polygons:
            poly.use_smooth = True
    return f"{ob.name} ({len(verts)} verts, {len(faces)} faces)"


def op_extrude_profile(o):
    """A closed 2D outline, given thickness.

    How hard-surface shapes are actually made: draw the silhouette, then give
    it depth. A car's side view -- sloped bonnet, raked screen, roofline,
    tapered boot -- is a profile, and no arrangement of cubes reproduces one.
    """
    prof = [(float(a), float(b)) for a, b in o["profile"]]
    if len(prof) < 3:
        raise ValueError("a profile needs at least three points")
    w = float(o.get("width", 1.0)) / 2
    axis = o.get("plane", "xz")

    def place(u, v, side):
        if axis == "xz":
            return (u, side * w, v)
        if axis == "xy":
            return (u, v, side * w)
        return (side * w, u, v)          # yz

    n = len(prof)
    verts = [place(u, v, -1) for u, v in prof] + [place(u, v, 1) for u, v in prof]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):                    # the wall between the two outlines
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))

    return op_mesh({"name": o.get("name", "Profile"), "verts": verts,
                    "faces": faces, "at": o.get("at"), "shade": o.get("shade")})


# ---------------------------------------------------------------- measuring
#
# Rendering and looking is a weak way to know things. The first car had a part
# entirely inside another part, glass buried in the bodywork, and wheels
# passing through the sill -- three faults, none of which a picture revealed
# and all of which are one number away from obvious.
#
# So: measure, and let a batch assert what must be true. An assertion that
# fails raises, and a failed operation stops the batch without saving -- which
# means a model cannot be written in a state it has already been told is wrong.

def _world_verts(ob, dg):
    """Evaluated geometry, in world space, modifiers included."""
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ob.matrix_world
    try:
        return [mw @ v.co.copy() for v in me.vertices], [p.vertices[:] for p in me.polygons]
    finally:
        ev.to_mesh_clear()


def _bvh(ob, dg):
    from mathutils.bvhtree import BVHTree
    verts, faces = _world_verts(ob, dg)
    return BVHTree.FromPolygons(verts, faces, all_triangles=False)


def _bounds(ob, dg):
    """World-space extent of what is actually THERE.

    Not ob.bound_box: that is the base mesh, before modifiers. A mirrored part
    reported the bounds of its unmirrored half, so an assert about how far the
    object reached passed on a number describing half of it -- a check that
    confirms the wrong thing is worse than no check.
    """
    verts, _ = _world_verts(ob, dg)
    if not verts:
        mw = ob.matrix_world
        pts = [mw @ mathutils.Vector(c) for c in ob.bound_box]
        return ([min(p[i] for p in pts) for i in range(3)],
                [max(p[i] for p in pts) for i in range(3)])
    return ([min(v[i] for v in verts) for i in range(3)],
            [max(v[i] for v in verts) for i in range(3)])


def _measure(o):
    """One fact about the scene, as a number."""
    dg = bpy.context.evaluated_depsgraph_get()
    what = o.get("what", "bounds")

    if what == "bounds":
        lo, hi = _bounds(_obj(o["name"]), dg)
        return {"what": "bounds", "name": o["name"],
                "min": [round(v, 4) for v in lo], "max": [round(v, 4) for v in hi],
                "size": [round(hi[i] - lo[i], 4) for i in range(3)]}

    if what == "overlap":
        a, b = _obj(o["name"]), _obj(o["with"])
        pairs = _bvh(a, dg).overlap(_bvh(b, dg))
        return {"what": "overlap", "name": o["name"], "with": o["with"],
                "overlapping_faces": len(pairs), "intersects": bool(pairs)}

    if what == "gap":
        # Closest approach between two surfaces. 0 means touching or crossing.
        a, b = _obj(o["name"]), _obj(o["with"])
        tb = _bvh(b, dg)
        verts, _ = _world_verts(a, dg)
        best = min((tb.find_nearest(v)[3] or 0.0) for v in verts) if verts else None
        return {"what": "gap", "name": o["name"], "with": o["with"],
                "gap": round(best, 4) if best is not None else None}

    if what == "enclosed":
        # Is this part entirely inside another's bounds -- i.e. invisible?
        # The failure that produced a Skirt nobody could see.
        alo, ahi = _bounds(_obj(o["name"]), dg)
        blo, bhi = _bounds(_obj(o["with"]), dg)
        inside = all(alo[i] >= blo[i] - 1e-6 and ahi[i] <= bhi[i] + 1e-6 for i in range(3))
        return {"what": "enclosed", "name": o["name"], "with": o["with"], "enclosed": inside}

    if what == "topology":
        # Placement checks catch a part in the wrong place. These catch a mesh
        # that is built wrong -- which is what "it looks like stacked
        # primitives" actually means underneath. Ngons shade unpredictably and
        # subdivide badly; non-manifold edges break booleans and solidify.
        import bmesh
        ob = _obj(o["name"])
        bm = bmesh.new()
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            bm.from_mesh(me)
            tris = quads = ngons = 0
            for f in bm.faces:
                n = len(f.verts)
                if n == 3: tris += 1
                elif n == 4: quads += 1
                else: ngons += 1
            nonmanifold = sum(1 for e in bm.edges if not e.is_manifold)
            loose = sum(1 for v in bm.verts if not v.link_edges)
            total = tris + quads + ngons
            return {"what": "topology", "name": o["name"],
                    "quads": quads, "tris": tris, "ngons": ngons,
                    "quad_ratio": round(quads / total, 3) if total else 0.0,
                    "non_manifold_edges": nonmanifold, "loose_verts": loose}
        finally:
            bm.free()
            ev.to_mesh_clear()

    if what == "counts":
        ob = _obj(o["name"])
        verts, faces = _world_verts(ob, dg)
        return {"what": "counts", "name": o["name"], "verts": len(verts), "faces": len(faces)}

    raise ValueError(f"unknown measurement {what!r}; try bounds, overlap, gap, enclosed, counts")


MEASURED = []


def op_measure(o):
    m = _measure(o)
    MEASURED.append(m)
    return json.dumps(m)


def op_assert(o):
    """Require something to be true, and stop the batch if it is not.

    Stopping matters: a failed operation aborts before the save, so a model is
    never written in a state it has already been told is wrong.
    """
    m = _measure(o)
    what = m["what"]

    if what == "overlap":
        want = bool(o.get("intersects", False))
        if m["intersects"] != want:
            raise ValueError(
                f"{o['name']} and {o['with']} "
                + ("do not intersect but should" if want
                   else f"intersect ({m['overlapping_faces']} face pairs) and should not"))
    elif what == "enclosed":
        want = bool(o.get("enclosed", False))
        if m["enclosed"] != want:
            raise ValueError(
                f"{o['name']} is {'' if m['enclosed'] else 'not '}entirely inside {o['with']}"
                + (" -- nothing of it can be seen" if m["enclosed"] else "")
                + f", expected {'enclosed' if want else 'visible'}")
    elif what == "gap":
        g = m["gap"]
        if "max" in o and g > float(o["max"]):
            raise ValueError(f"{o['name']} is {g} from {o['with']}, further than {o['max']}")
        if "min" in o and g < float(o["min"]):
            raise ValueError(f"{o['name']} is {g} from {o['with']}, closer than {o['min']}")
    elif what == "topology":
        for key, limit in (("ngons", "max_ngons"), ("tris", "max_tris"),
                           ("non_manifold_edges", "max_non_manifold"),
                           ("loose_verts", "max_loose_verts")):
            if limit in o and m[key] > int(o[limit]):
                raise ValueError(f"{o['name']} has {m[key]} {key.replace('_', ' ')}, more than {o[limit]}")
        if "min_quad_ratio" in o and m["quad_ratio"] < float(o["min_quad_ratio"]):
            raise ValueError(
                f"{o['name']} is {int(m['quad_ratio'] * 100)}% quads, below "
                f"{int(float(o['min_quad_ratio']) * 100)}% -- it will subdivide and shade badly")
    elif what == "bounds":
        for i, axis in enumerate("xyz"):
            lo, hi = o.get(f"{axis}_min"), o.get(f"{axis}_max")
            if lo is not None and m["min"][i] < float(lo) - 1e-6:
                raise ValueError(f"{o['name']} reaches {m['min'][i]} on {axis}, below {lo}")
            if hi is not None and m["max"][i] > float(hi) + 1e-6:
                raise ValueError(f"{o['name']} reaches {m['max'][i]} on {axis}, above {hi}")
    else:
        raise ValueError(f"cannot assert on {what!r}")

    MEASURED.append(m)
    return f"ok: {json.dumps(m)}"


def op_shade(o):
    """Smooth or flat shading, optionally by angle.

    A low-poly form shaded flat reads as facets; the same mesh smoothed above
    an angle reads as a curved body with crisp edges where the edges are sharp.
    It is the cheapest quality change available and it is not modelling at all.
    """
    ob = _obj(o["name"])
    for p in ob.data.polygons:
        p.use_smooth = o.get("smooth", True)
    angle = o.get("angle_deg")
    if angle is not None and o.get("smooth", True):
        bpy.context.view_layer.objects.active = ob
        try:
            bpy.ops.object.shade_auto_smooth(angle=math.radians(float(angle)))
        except (AttributeError, RuntimeError):
            # Older Blender kept this as a mesh flag rather than a modifier.
            if hasattr(ob.data, "use_auto_smooth"):
                ob.data.use_auto_smooth = True
                ob.data.auto_smooth_angle = math.radians(float(angle))
    return f"{ob.name}: {'smooth' if o.get('smooth', True) else 'flat'}"


OPS = {
    "add": op_add,
    "mesh": op_mesh,
    "shade": op_shade,
    "measure": op_measure,
    "assert": op_assert,
    "extrude_profile": op_extrude_profile,
    "transform": op_transform,
    "modifier": op_modifier,
    "apply_modifiers": op_apply_modifiers,
    "delete": op_delete,
    "rename": op_rename,
    "material": op_material,
}


def scene():
    """The scene as text. This is what an agent can actually reason about --
    the same reason reading a page beat screenshotting one."""
    out = []
    for o in bpy.data.objects:
        out.append({
            "name": o.name,
            "type": o.type,
            "at": [round(v, 3) for v in o.location],
            "size": [round(v, 3) for v in o.dimensions],
            "rotation_deg": [round(math.degrees(v), 1) for v in o.rotation_euler],
            "modifiers": [m.type for m in o.modifiers],
            "material": (o.data.materials[0].name
                         if getattr(o.data, "materials", None) and len(o.data.materials) else None),
        })
    return out


def _stage():
    """Camera, light and a sky, framed on whatever is actually there.

    The first render came back almost black: a fixed camera pointed at a
    guessed spot, one weak sun, and a metallic material with no world to
    reflect. That matters more here than it would elsewhere -- the render IS
    the agent's feedback loop, so an unreadable one makes every later decision
    blind. A model it cannot see is a model it cannot correct.
    """
    scn = bpy.context.scene

    # A sky. Metals are black without one, because a mirror with nothing to
    # mirror is just dark.
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.05, 0.06, 0.08, 1.0)
        bg.inputs["Strength"].default_value = 1.0

    if not any(o.type == "LIGHT" for o in bpy.data.objects):
        bpy.ops.object.light_add(type="AREA", location=(4, -4, 6))
        key = bpy.context.active_object
        key.data.energy = 1200
        key.data.size = 6
        key.rotation_euler = (math.radians(45), 0, math.radians(45))
        bpy.ops.object.light_add(type="AREA", location=(-5, -2, 3))
        fill = bpy.context.active_object
        fill.data.energy = 300
        fill.data.size = 8

    # Framed on the scene's own bounds rather than a fixed point, so a large
    # model is not off the edge and a small one is not a dot.
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if meshes:
        # Evaluated bounds, for the same reason the measure op uses them: a
        # mirrored or arrayed model has a base mesh far smaller than the thing
        # on screen, and framing on the base mesh crops the render.
        dg = bpy.context.evaluated_depsgraph_get()
        xs, ys, zs = [], [], []
        for o in meshes:
            lo, hi = _bounds(o, dg)
            xs += [lo[0], hi[0]]; ys += [lo[1], hi[1]]; zs += [lo[2], hi[2]]
        cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
        span = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), 1.0)
        d = span * 2.2
        cam = next((o for o in bpy.data.objects if o.type == "CAMERA"), None)
        if cam is None:
            bpy.ops.object.camera_add()
            cam = bpy.context.active_object
        cam.location = (cx + d * 0.7, cy - d * 0.8, cz + d * 0.6)
        direction = mathutils.Vector((cx, cy, cz)) - cam.location
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scn.camera = cam


def main():
    path, req = _args()

    if os.path.exists(path):
        bpy.ops.wm.open_mainfile(filepath=path)
    elif req.get("start") == "default":
        pass                                   # the factory scene, cube and all
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)

    done, errors = [], []
    for o in req.get("ops", []):
        fn = OPS.get(o.get("op"))
        if fn is None:
            errors.append(f"unknown operation {o.get('op')!r}; known: {', '.join(sorted(OPS))}")
            break
        try:
            done.append(f"{o['op']} -> {fn(o)}")
        except Exception as e:                 # noqa: BLE001 -- reported, not raised
            errors.append(f"{o.get('op')}: {e}")
            break

    # Saved only when every operation succeeded. A half-applied batch is worse
    # than a rejected one: the agent would be reasoning about a scene that
    # matches neither what it asked for nor what it last saw.
    if not errors:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=path)

    render = None
    if req.get("render") and not errors:
        r = bpy.context.scene.render
        r.filepath = req["render"]
        r.resolution_x = int(req.get("width", 800))
        r.resolution_y = int(req.get("height", 600))
        r.image_settings.file_format = "PNG"
        _stage()
        bpy.ops.render.render(write_still=True)
        render = req["render"]

    print("OMATRON_RESULT " + json.dumps({
        "applied": done, "errors": errors, "scene": scene(), "render": render,
        "measured": MEASURED,
    }))


main()
