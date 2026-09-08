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
import tempfile


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
        # Subdivision has rules, and breaking them produces a specific, ugly,
        # recognisable result rather than an error. So say so at the point of
        # use, where it can still be acted on.
        m = ob.modifiers.new(name="Subdivision", type="SUBSURF")
        m.levels = m.render_levels = int(o.get("levels", 2))

        import bmesh
        bm = bmesh.new()
        try:
            bm.from_mesh(ob.data)
            ngons = sum(1 for f in bm.faces if len(f.verts) > 4)
            tris = sum(1 for f in bm.faces if len(f.verts) == 3)
            cage = len(bm.faces)
            order = [x.type for x in ob.modifiers]
        finally:
            bm.free()

        warn = []
        if ngons:
            warn.append(f"{ngons} ngon(s) -- these pinch and crease unpredictably under "
                        "subdivision; booleans make them freely, so clean up after one")
        if tris:
            warn.append(f"{tris} triangle(s) -- these pinch too, though less than ngons")
        if cage < 200:
            warn.append(f"the cage is only {cage} face(s). Subdivision SMOOTHS a shape, it "
                        "cannot invent one: too coarse a cage subdivides into a blob no "
                        "matter how it is creased. Add resolution first")
        if "BEVEL" in order and order.index("BEVEL") > order.index("SUBSURF"):
            warn.append("Bevel sits AFTER Subdivision in the stack; it belongs before, or it "
                        "bevels the already-smoothed result instead of holding its edges")
        crease_layer = ob.data.attributes.get("crease_edge")
        if crease_layer is None and "BEVEL" not in order:
            warn.append("nothing is holding any edge: subdivision softens every one of them. "
                        "Crease the edges that must stay sharp, or bevel them (1-2 segments) "
                        "to give them support loops")

        return f"{ob.name}: {m.type}" + ("  [" + "; ".join(warn) + "]" if warn else "")
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
        # Is this part entirely inside another -- i.e. invisible? The failure
        # that produced a Skirt nobody could see, and glass buried in bodywork.
        #
        # Bounding boxes cannot answer this. A windscreen sits inside the car's
        # overall box while protruding through the roof surface, and a bbox
        # test calls that "enclosed" and blocks a perfectly good model. What
        # matters is the SURFACE: is every vertex of A inside B's volume?
        #
        # Ray parity gives that: fire a ray from each vertex and count how many
        # times it crosses B. Odd means it started inside.
        a, b = _obj(o["name"]), _obj(o["with"])
        tb = _bvh(b, dg)
        verts, _ = _world_verts(a, dg)
        d = mathutils.Vector((0.5773, 0.5774, 0.5775)).normalized()  # nothing axis-aligned
        outside = 0
        for v in verts:
            origin, hits = v.copy(), 0
            while hits < 64:
                loc = tb.ray_cast(origin + d * 1e-5, d)[0]
                if loc is None:
                    break
                hits += 1
                origin = loc
            if hits % 2 == 0:
                outside += 1
        return {"what": "enclosed", "name": o["name"], "with": o["with"],
                "enclosed": outside == 0, "verts_outside": outside, "verts": len(verts)}

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
            # Two different conditions, and conflating them makes the check
            # useless. An edge with one face is a BOUNDARY -- an open edge,
            # which is exactly what a half-mesh awaiting a mirror has along
            # its centreline, and entirely correct there. An edge with three
            # or more is genuinely non-manifold and will break booleans and
            # solidify. bmesh's is_manifold reports both as False, so a
            # perfectly good half-body failed a check it should have passed.
            boundary = sum(1 for e in bm.edges if len(e.link_faces) == 1)
            nonmanifold = sum(1 for e in bm.edges if len(e.link_faces) > 2)
            loose = sum(1 for v in bm.verts if not v.link_edges)
            total = tris + quads + ngons
            return {"what": "topology", "name": o["name"],
                    "quads": quads, "tris": tris, "ngons": ngons,
                    "quad_ratio": round(quads / total, 3) if total else 0.0,
                    "non_manifold_edges": nonmanifold, "boundary_edges": boundary,
                    "loose_verts": loose}
        finally:
            bm.free()
            ev.to_mesh_clear()

    if what == "silhouette":
        # Compared in WORLD SPACE, against the drawing where it actually sits.
        #
        # The first version normalised each outline to its own bounding box
        # before overlapping them. That threw away position and scale -- the
        # two things a blueprint exists to pin down -- so a model floating
        # above the drawing at the wrong size still scored well, and the number
        # I led with (bounding-box aspect ratio) is one a plain rectangle
        # scores perfectly on. Both masks are now sampled on the same world
        # window, so overlap means "is the model where the drawing says".
        import numpy as np
        view = str(o.get("view", "side")).lower()
        if view not in _VIEWS:
            raise ValueError(f"view is one of {', '.join(_VIEWS)}")
        raw = bpy.context.scene.get(f"omatron_ref_{view}")
        if not raw:
            raise ValueError(
                f"no {view} reference. Attach one first, with its real size: "
                f'{{"op":"reference","view":"{view}","image":"...","length":4.17}}')
        try:
            cal = json.loads(raw)
        except (TypeError, ValueError):
            raise ValueError(
                "this model carries a reference from an older, uncalibrated version. "
                "Attach it again with a length or height so it has a scale.")

        grid = int(o.get("resolution", 384))
        mpp, (x0, x1, ylo, yhi), (iw, ih) = cal["mpp"], cal["px"], cal["size"]

        # The drawing, in world units: centred on x=0, ground line on z=0.
        cx = (x0 + x1) / 2.0
        ref_x = (-(cx - x0) * mpp, (x1 - cx) * mpp)
        ref_z = (0.0, (yhi - ylo) * mpp)

        lo, hi = None, None
        dg = bpy.context.evaluated_depsgraph_get()
        for ob in bpy.data.objects:
            if ob.type != "MESH" or ob.hide_render:
                continue
            a, b = _bounds(ob, dg)
            lo = a if lo is None else [min(lo[i], a[i]) for i in range(3)]
            hi = b if hi is None else [max(hi[i], b[i]) for i in range(3)]
        if lo is None:
            raise ValueError("nothing to compare")

        # One window covering both, so neither is cropped and neither is moved.
        wx = (min(ref_x[0], lo[0]), max(ref_x[1], hi[0]))
        wz = (min(ref_z[0], lo[2]), max(ref_z[1], hi[2]))
        span = max(wx[1] - wx[0], wz[1] - wz[0]) * 1.08
        mid = ((wx[0] + wx[1]) / 2.0, (wz[0] + wz[1]) / 2.0)

        shot = os.path.expanduser(str(o.get("to") or f"/tmp/omatron-cmp-{view}.png"))
        _render_ortho(view, shot, grid, frame=(mid, span))

        mine_img = bpy.data.images.load(shot, check_existing=False)
        ref_img = bpy.data.images.load(os.path.expanduser(cal["path"]), check_existing=False)
        try:
            mine = _mask_from_pixels(mine_img.pixels[:], *mine_img.size)
            ref_full = _fill_holes(_mask_from_pixels(ref_img.pixels[:], *ref_img.size))
        finally:
            bpy.data.images.remove(mine_img)
            bpy.data.images.remove(ref_img)

        # Sample the drawing onto that same window, pixel for pixel.
        gx = np.linspace(mid[0] - span / 2, mid[0] + span / 2, grid)
        gz = np.linspace(mid[1] - span / 2, mid[1] + span / 2, grid)
        px_x = np.clip(np.round(cx + gx / mpp).astype("int32"), 0, iw - 1)
        px_y = np.clip(np.round(ylo + gz / mpp).astype("int32"), 0, ih - 1)
        ref = ref_full[np.ix_(px_y, px_x)]

        # An overlay, because "31% of the drawing is uncovered" does not say
        # WHERE. Red is drawing the model does not reach, blue is model outside
        # the drawing, grey is agreement. One glance replaces a paragraph.
        overlay = os.path.expanduser(str(o.get("overlay") or shot.replace(".png", "-overlay.png")))
        try:
            rgba = np.zeros((grid, grid, 4), dtype="float32")
            rgba[..., 3] = 1.0
            both, only_m, only_r = mine & ref, mine & ~ref, ref & ~mine
            rgba[both] = (0.62, 0.64, 0.66, 1.0)
            rgba[only_r] = (0.85, 0.16, 0.16, 1.0)    # drawing, unfilled
            rgba[only_m] = (0.18, 0.42, 0.90, 1.0)    # model, overhanging
            out = bpy.data.images.new("omatron_overlay", grid, grid, alpha=True)
            out.pixels = rgba.reshape(-1)
            out.filepath_raw = overlay
            out.file_format = "PNG"
            out.save()
            bpy.data.images.remove(out)
        except Exception:
            overlay = None

        inter, union = int((mine & ref).sum()), int((mine | ref).sum())
        only_mine, only_ref = int((mine & ~ref).sum()), int((ref & ~mine).sum())
        return {"what": "silhouette", "view": view,
                "overlap": round(inter / union, 4) if union else 0.0,
                "model_outside_drawing": round(only_mine / max(union, 1), 4),
                "drawing_uncovered": round(only_ref / max(union, 1), 4),
                "model_size": [round(hi[0] - lo[0], 3), round(hi[2] - lo[2], 3)],
                "drawing_size": [round(ref_x[1] - ref_x[0], 3), round(ref_z[1] - ref_z[0], 3)],
                "rendered": shot, "overlay": overlay}

    if what == "selection":
        # What a select actually caught. Guessing at a region and then
        # extruding is how you get a change you did not intend.
        import bmesh
        ob = _obj(o["name"])
        bm = bmesh.new()
        try:
            bm.from_mesh(ob.data)
            return {"what": "selection", "name": o["name"],
                    "faces": sum(1 for f in bm.faces if f.select),
                    "edges": sum(1 for e in bm.edges if e.select)}
        finally:
            bm.free()

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
    elif what == "silhouette":
        if "min_overlap" in o and m["overlap"] < float(o["min_overlap"]):
            raise ValueError(
                f"{m['view']} silhouette overlaps the drawing {int(m['overlap'] * 100)}%, "
                f"below {int(float(o['min_overlap']) * 100)}%. "
                f"{int(m['model_outside_drawing'] * 100)}% of the frame is model where the "
                f"drawing has none, {int(m['drawing_uncovered'] * 100)}% is drawing the model "
                f"does not fill. Model is {m['model_size'][0]}x{m['model_size'][1]} m against "
                f"the drawing's {m['drawing_size'][0]}x{m['drawing_size'][1]} — see {m['rendered']}")

    elif what == "topology":
        for key, limit in (("ngons", "max_ngons"), ("tris", "max_tris"),
                           ("non_manifold_edges", "max_non_manifold"),
                           ("boundary_edges", "max_boundary"),
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


def op_normals(o):
    """Point every face outward.

    A mesh built from explicit vertices has whatever winding the caller
    happened to write, and a face wound the wrong way shades as a hole. This is
    the "recalculate outside" every modeller reaches for after building
    geometry by hand, and there is no way to get it right by guessing at vertex
    order instead.
    """
    import bmesh
    ob = _obj(o["name"])
    bm = bmesh.new()
    try:
        bm.from_mesh(ob.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if o.get("flip"):
            bmesh.ops.reverse_faces(bm, faces=bm.faces)
        bm.to_mesh(ob.data)
        ob.data.update()
        return f"{ob.name}: {len(bm.faces)} faces reoriented"
    finally:
        bm.free()


# ------------------------------------------------- selecting, and editing what
#
# Everything above works on whole objects: add a primitive, loft a mesh, apply
# a modifier to all of it, boolean one against another. That is enough to
# assemble a shape and not enough to MODEL one, because a car body is defined
# by its creases -- a beltline, a shoulder, the edge of a bonnet -- and there
# was no way to address a single edge to crease it.
#
# So: a selection, and operations on it. Selection lives in the mesh's own
# select flags, which means it survives from one operation to the next inside a
# batch, and each operation leaves behind the geometry it created -- inset then
# extrude is a recess, with no second selection needed.

_AXES = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0),
         "-y": (0, -1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}


def _open(ob):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    return bm


def _close(bm, ob):
    bm.to_mesh(ob.data)
    ob.data.update()
    bm.free()


def _selected(bm, kind):
    seq = bm.faces if kind == "faces" else bm.edges
    return [e for e in seq if e.select]


def _require(sel, what, o):
    """An empty selection is a silent no-op, and this project does not ship those.

    Extruding nothing reports success and changes nothing, which is how you end
    up trusting a batch that did half of what you asked. Same treatment as an
    array with zero offset and a mirror about its own origin: say so, loudly,
    and take the batch down.
    """
    if not sel:
        raise ValueError(
            f"nothing selected on {o['name']}: this would {what} zero elements. "
            "Widen the region, raise the normal tolerance, or lower sharper_than "
            "-- and use measure what=selection to see what a select actually caught.")
    return sel


def op_select(o):
    """Choose faces and edges by where they are and which way they face.

    Not by index: an index means nothing to a caller who did not build the mesh
    vertex by vertex, and it changes the moment anything is inset or bevelled.
    Position and direction stay meaningful across edits.
    """
    ob = _obj(o["name"])
    bm = _open(ob)
    mw = ob.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()

    faces, edges = list(bm.faces), list(bm.edges)
    trail = [f"start {len(faces)}f/{len(edges)}e"]   # where the set died

    if "region" in o:
        r = [float(v) for v in o["region"]]
        if len(r) != 6:
            raise ValueError("region is [x0,y0,z0, x1,y1,z1] -- six numbers")
        lo = [min(r[i], r[i + 3]) for i in range(3)]
        hi = [max(r[i], r[i + 3]) for i in range(3)]

        def inside(p):
            return all(lo[i] - 1e-6 <= p[i] <= hi[i] + 1e-6 for i in range(3))

        faces = [f for f in faces if inside(mw @ f.calc_center_median())]
        edges = [e for e in edges
                 if inside(mw @ ((e.verts[0].co + e.verts[1].co) / 2.0))]
        trail.append(f"after region {len(faces)}f/{len(edges)}e")

    if "normal" in o:
        key = str(o["normal"]).lower()
        if key not in _AXES:
            raise ValueError(f"normal is one of {', '.join(sorted(_AXES))}")
        want = mathutils.Vector(_AXES[key])
        tol = math.radians(float(o.get("tol", 35.0)))
        faces = [f for f in faces if (nm @ f.normal).normalized().angle(want, math.pi) <= tol]
        keep = set(faces)
        edges = [e for e in edges if e.link_faces and all(f in keep for f in e.link_faces)]
        trail.append(f"after normal {len(faces)}f/{len(edges)}e")

    if "sharper_than" in o:
        lim = math.radians(float(o["sharper_than"]))
        edges = [e for e in edges
                 if len(e.link_faces) == 2 and e.calc_face_angle(0.0) >= lim]
        trail.append(f"after sharper_than {len(edges)}e")

    want = o.get("elements", "both")
    for f in bm.faces:
        f.select = False
    for e in bm.edges:
        e.select = False
    if want in ("faces", "both"):
        for f in faces:
            f.select = True
    if want in ("edges", "both"):
        for e in edges:
            e.select = True

    n_f, n_e = len(faces) if want != "edges" else 0, len(edges) if want != "faces" else 0
    _close(bm, ob)
    if not n_f and not n_e:
        # Say WHICH filter emptied the set. "Nothing matched" sent me tuning a
        # region that was fine, when it was the normal tolerance that had
        # rejected everything -- the trail makes that a glance instead of a
        # guess.
        dg = bpy.context.evaluated_depsgraph_get()
        lo, hi = _bounds(ob, dg)
        raise ValueError(
            f"nothing on {ob.name} matched that selection: "
            + " -> ".join(trail)
            + f". The object spans {[round(v, 2) for v in lo]} to {[round(v, 2) for v in hi]}.")
    return f"{ob.name}: {n_f} face(s), {n_e} edge(s)"


def op_crease(o):
    """Hold an edge sharp through subdivision -- how a feature line is made."""
    ob = _obj(o["name"])
    bm = _open(ob)
    # The layer FIRST. Creating one reallocates the edge sequence, which
    # invalidates every BMEdge already held -- so collecting the selection
    # before this line hands you references that are dead by the time you
    # assign through them ("BMesh data of type BMEdge has been removed").
    layer = bm.edges.layers.float.get("crease") or bm.edges.layers.float.new("crease")
    bm.edges.ensure_lookup_table()
    sel = _require(_selected(bm, "edges"), "crease", o)
    w = float(o.get("weight", 1.0))
    for e in sel:
        e[layer] = max(0.0, min(1.0, w))
    _close(bm, ob)
    return f"{ob.name}: creased {len(sel)} edge(s) at {w}"


def op_inset(o):
    """Ring a face inward. The first half of every recess, panel and lamp."""
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = _require(_selected(bm, "faces"), "inset", o)
    res = bmesh.ops.inset_region(
        bm, faces=sel, thickness=float(o.get("thickness", 0.02)),
        depth=float(o.get("depth", 0.0)), use_even_offset=True)
    # Leave the INNER faces selected, so extrude follows without reselecting.
    inner = [f for f in sel]
    for f in bm.faces:
        f.select = False
    for f in inner:
        f.select = True
    _close(bm, ob)
    return f"{ob.name}: inset {len(sel)} face(s), {len(res.get('faces', []))} new"


def op_extrude(o):
    """Push selected faces out, or in. Bumpers, sills, spoilers, recesses."""
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = _require(_selected(bm, "faces"), "extrude", o)

    if "offset" in o:
        vec = mathutils.Vector(_vec(o["offset"]))
    else:
        d = float(o.get("distance", 0.05))
        n = mathutils.Vector((0, 0, 0))
        for f in sel:
            n += f.normal
        if n.length < 1e-9:
            raise ValueError(
                "the selected faces point in opposing directions, so there is no "
                "single normal to extrude along -- give an explicit offset [x,y,z]")
        vec = n.normalized() * d

    res = bmesh.ops.extrude_face_region(bm, geom=sel)
    verts = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=vec, verts=verts)
    bmesh.ops.delete(bm, geom=sel, context="FACES")

    new = [g for g in res["geom"] if isinstance(g, bmesh.types.BMFace)]
    for f in bm.faces:
        f.select = False
    for f in new:
        if f.is_valid:
            f.select = True
    _close(bm, ob)
    return f"{ob.name}: extruded {len(sel)} face(s) by {[round(v, 3) for v in vec]}"


def op_bevel_edges(o):
    """Bevel chosen edges only -- unlike the modifier, which takes all of them."""
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = _require(_selected(bm, "edges"), "bevel", o)
    bmesh.ops.bevel(bm, geom=sel, offset=float(o.get("width", 0.02)),
                    segments=int(o.get("segments", 2)), affect="EDGES",
                    profile=float(o.get("profile", 0.5)))
    _close(bm, ob)
    return f"{ob.name}: bevelled {len(sel)} edge(s)"


def op_loop_cut(o):
    """Add loops through the selected edges -- support loops, or more resolution."""
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = _require(_selected(bm, "edges"), "cut", o)
    bmesh.ops.subdivide_edges(bm, edges=sel, cuts=int(o.get("cuts", 1)),
                              use_grid_fill=True)
    _close(bm, ob)
    return f"{ob.name}: {o.get('cuts', 1)} cut(s) through {len(sel)} edge(s)"


def op_delete_faces(o):
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = _require(_selected(bm, "faces"), "delete", o)
    bmesh.ops.delete(bm, geom=sel, context="FACES")
    _close(bm, ob)
    return f"{ob.name}: deleted {len(sel)} face(s)"


# ------------------------------------------------------ working from a blueprint
#
# Proportions were right on the last car by luck: I picked numbers, and they
# happened to land near a real hatchback. Form was not, because there was
# nothing to check form AGAINST. A modeller works over orthographic blueprints
# -- side, front, top -- and every judgement is "does this match the drawing".
#
# So: attach reference images, render matching orthographic views, and compare
# the silhouettes as a number.
#
# The comparison normalises both outlines to their own bounding boxes before
# overlapping them, which makes it scale-invariant on purpose: a blueprint
# arrives at whatever size it was drawn, and what matters is whether the SHAPE
# agrees, not whether someone scaled the scan to metres.

# The vector is the direction the camera LOOKS, which must agree with the
# rotation beside it -- a camera at (0,0,0) looks down -Z, and each rotation
# below turns that onto the axis named. Storing "where the camera sits" instead
# put the side camera on the far side of the model, pointing away from it, and
# rendered a blank frame that looked exactly like a model that had failed to
# load.
_VIEWS = {
    # view     look direction   rotation (rad)                   width axis, height axis
    "side":  ((0, 1, 0), (math.pi / 2, 0, 0), 0, 2),
    "front": ((-1, 0, 0), (math.pi / 2, 0, math.pi / 2), 1, 2),
    "top":   ((0, 0, -1), (0, 0, 0), 0, 1),
}


def op_reference(o):
    """Attach a blueprint, CALIBRATED, and place it where the model will be.

    The first version put a plate of arbitrary size at the origin. It looked
    like a reference and was not one: a rectangle floating inside the car at no
    particular scale, aligned with nothing. A drawing you cannot lay the model
    against is decoration.

    So the caller says how long (or how tall) the drawn vehicle really is, and
    the drawing is measured to find its own outline. From those two the scale
    follows, and the plate is placed with the drawing's GROUND LINE on z=0 and
    its centre on x=0 -- where the model is going to be built. Now they overlap
    in the viewport, and the overlap means something.
    """
    view = str(o.get("view", "side")).lower()
    if view not in _VIEWS:
        raise ValueError(f"view is one of {', '.join(_VIEWS)}")
    path = os.path.expanduser(str(o["image"]))
    if not os.path.exists(path):
        raise ValueError(f"no such reference image: {path}")

    length, height = o.get("length"), o.get("height")
    if not length and not height:
        raise ValueError(
            "give the real size of the drawn vehicle: length (along the drawing's "
            "width) or height. Without it the drawing has no scale, and a reference "
            "with no scale cannot be compared against or laid under anything.")

    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        mask = _fill_holes(_mask_from_pixels(img.pixels[:], w, h))
    finally:
        bpy.data.images.remove(img)

    import numpy as np
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if not len(rows) or not len(cols):
        raise ValueError(f"{os.path.basename(path)} has no visible outline to measure")
    # Blender hands back pixels bottom-up; row 0 is the BOTTOM of the image.
    x0, x1, ylo, yhi = int(cols[0]), int(cols[-1]), int(rows[0]), int(rows[-1])
    mpp = (float(length) / (x1 - x0 + 1)) if length else (float(height) / (yhi - ylo + 1))

    cal = {"path": path, "mpp": mpp, "px": [x0, x1, ylo, yhi], "size": [w, h]}
    bpy.context.scene[f"omatron_ref_{view}"] = json.dumps(cal)

    name = f"Reference_{view}"
    old_ob = bpy.data.objects.get(name)
    if old_ob:
        bpy.data.objects.remove(old_ob, do_unlink=True)
    try:
        image = bpy.data.images.load(path, check_existing=True)
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "IMAGE"
        empty.data = image
        # empty_display_size is the world span of the image's LONGER side.
        long_px = max(w, h)
        empty.empty_display_size = long_px * mpp
        world_w, world_h = w * mpp, h * mpp
        # Put the outline's centre on x=0 and its ground line on z=0.
        cx_px = (x0 + x1) / 2.0
        off_x = (cx_px / w - 0.5) * world_w
        off_z = (ylo / h - 0.5) * world_h
        empty.rotation_euler = _VIEWS[view][1]
        empty.location = (-off_x, float(o.get("depth", 1.2)), -off_z)
        empty.hide_render = True
        bpy.context.scene.collection.objects.link(empty)
    except Exception:
        pass

    return (f"{view}: {os.path.basename(path)} — outline {(x1 - x0 + 1) * mpp:.2f} x "
            f"{(yhi - ylo + 1) * mpp:.2f} m at {mpp * 1000:.2f} mm/px")


def _mask_from_pixels(px, w, h):
    """A boolean silhouette. Alpha where there is any, ink-vs-paper otherwise.

    Decided from the image rather than declared by the caller: a transparent
    PNG blueprint and our own render both want the alpha channel, and a flat
    scan wants the ink. Testing max() > 0 was wrong -- every image has at least
    one opaque pixel, so it never once fell through to the ink path.
    """
    import numpy as np
    a = np.array(px, dtype="float32").reshape(h, w, 4)
    if a[:, :, 3].min() < 0.5:            # genuinely transparent somewhere
        return a[:, :, 3] > 0.5
    lum = a[:, :, :3].mean(axis=2)
    # A blueprint is dark on light far more often than the reverse; decide by
    # which way round this one is rather than assuming.
    ink = lum < 0.5
    return ink if ink.mean() < 0.5 else ~ink


def _fill_holes(mask):
    """Close interior gaps, so the outline is the SILHOUETTE and nothing else.

    A drawn car is not one flat colour: this blueprint has pale blue glass and
    grey wheel centres, which the ink threshold reads as paper and punches into
    holes. The outline of the car is unaffected by what colour its windows are,
    so the comparison should not be either.

    Flood from the border; whatever the flood cannot reach is inside.
    """
    import numpy as np
    bg = ~mask
    reach = np.zeros_like(bg)
    reach[0, :] |= bg[0, :]
    reach[-1, :] |= bg[-1, :]
    reach[:, 0] |= bg[:, 0]
    reach[:, -1] |= bg[:, -1]
    for _ in range(mask.shape[0] + mask.shape[1]):
        grown = reach.copy()
        grown[1:, :] |= reach[:-1, :]
        grown[:-1, :] |= reach[1:, :]
        grown[:, 1:] |= reach[:, :-1]
        grown[:, :-1] |= reach[:, 1:]
        grown &= bg
        if (grown == reach).all():
            break
        reach = grown
    return ~reach


def _normalised(mask, grid=128):
    """Crop to the outline's own box, then resample to a fixed grid.

    Scale-invariant by construction: a drawing scanned at any size and a render
    at any distance both become the same 128x128 question about shape.
    """
    import numpy as np
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if not len(rows) or not len(cols):
        return None
    sub = mask[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    ys = (np.linspace(0, sub.shape[0] - 1, grid)).astype("int32")
    xs = (np.linspace(0, sub.shape[1] - 1, grid)).astype("int32")
    return _fill_holes(sub[ys][:, xs]), (len(cols), len(rows))


def _render_ortho(view, path, res=400, frame=None):
    """One orthographic view of the model, framed on the model, alpha only."""
    lo, hi = None, None
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in bpy.data.objects:
        if ob.type != "MESH" or ob.hide_render:
            continue
        a, b = _bounds(ob, dg)
        lo = a if lo is None else [min(lo[i], a[i]) for i in range(3)]
        hi = b if hi is None else [max(hi[i], b[i]) for i in range(3)]
    if lo is None:
        raise ValueError("nothing to render")

    centre = [(lo[i] + hi[i]) / 2 for i in range(3)]
    span = max(hi[i] - lo[i] for i in range(3)) or 1.0
    if frame is not None:
        # An explicit world window, so a comparison renders the model where it
        # actually is rather than re-centring it into the frame -- re-centring
        # is what let a floating model score well.
        (fx, fz), span = frame
        wi, hi_ax = _VIEWS[view][2], _VIEWS[view][3]
        centre = list(centre)
        centre[wi], centre[hi_ax] = fx, fz
    direction, rot, _, _ = _VIEWS[view]

    cam_data = bpy.data.cameras.new("OmatronOrtho")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = span * 1.15
    cam = bpy.data.objects.new("OmatronOrtho", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = [centre[i] - direction[i] * span * 4 for i in range(3)]   # behind the look
    cam.rotation_euler = rot

    sc = bpy.context.scene
    keep = (sc.camera, sc.render.filepath, sc.render.resolution_x,
            sc.render.resolution_y, sc.render.film_transparent)
    try:
        sc.camera = cam
        sc.render.resolution_x = sc.render.resolution_y = res
        sc.render.film_transparent = True          # alpha IS the silhouette
        sc.render.image_settings.color_mode = "RGBA"
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
    finally:
        (sc.camera, sc.render.filepath, sc.render.resolution_x,
         sc.render.resolution_y, sc.render.film_transparent) = keep
        bpy.data.objects.remove(cam, do_unlink=True)
    return path


def op_render_view(o):
    """An orthographic side, front or top view -- the drawing, from the model."""
    view = str(o.get("view", "side")).lower()
    if view not in _VIEWS:
        raise ValueError(f"view is one of {', '.join(_VIEWS)}")
    out = os.path.expanduser(str(o.get("to") or f"/tmp/omatron-{view}.png"))
    _render_ortho(view, out, int(o.get("resolution", 400)))
    return f"{view} view -> {out}"


# ------------------------------------------------------------------ looking
#
# The batch used to be blind: apply forty operations, render once at the end,
# and discover the nose was mangled with no idea which operation did it. The
# render was feedback about the RESULT, not about the process, so a bad result
# cost the whole build and told you nothing about where it went wrong.
#
# A look is a checkpoint: the model as it stands, right now, with the numbers
# that go with that picture. Several in one batch and you can see the form
# arrive step by step -- and when a later operation fails, the looks taken
# before it still come back, so the failure arrives WITH the evidence.

CHECKPOINTS = []
LOOK_LIMIT = 8


def _look_stats():
    """The numbers beside the picture. Compact -- this is read, not stored."""
    dg = bpy.context.evaluated_depsgraph_get()
    rows, faces = [], 0
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            n = len(me.polygons)
        finally:
            ev.to_mesh_clear()
        faces += n
        lo, hi = _bounds(ob, dg)
        rows.append({"name": ob.name, "faces": n,
                     "size": [round(hi[i] - lo[i], 3) for i in range(3)]})
    return {"objects": rows, "faces": faces}


def op_look(o):
    """Render the model as it stands, part-way through the batch."""
    if len(CHECKPOINTS) >= LOOK_LIMIT:
        raise ValueError(
            f"that is more than {LOOK_LIMIT} looks in one batch. Each one is a full "
            "render; if you need more checkpoints than this, the batch is doing too "
            "much at once -- split it and look between the calls instead.")

    label = str(o.get("label") or f"step {len(CHECKPOINTS) + 1}")
    view = str(o.get("view", "staged")).lower()
    res = max(160, min(int(o.get("resolution", 480)), 900))
    out = os.path.join(tempfile.gettempdir(),
                       f"omatron-look-{os.getpid()}-{len(CHECKPOINTS)}.png")

    if view in _VIEWS:
        _render_ortho(view, out, res)
    else:
        r = bpy.context.scene.render
        keep = (r.filepath, r.resolution_x, r.resolution_y, r.film_transparent)
        try:
            _stage()
            r.filepath = out
            r.resolution_x, r.resolution_y = res, int(res * 0.75)
            r.film_transparent = False
            r.image_settings.file_format = "PNG"
            bpy.ops.render.render(write_still=True)
        finally:
            (r.filepath, r.resolution_x, r.resolution_y, r.film_transparent) = keep

    # The measurements taken since the previous look belong to THIS picture.
    since = CHECKPOINTS[-1]["measured_to"] if CHECKPOINTS else 0
    CHECKPOINTS.append({
        "label": label, "view": view, "image": out,
        "stats": _look_stats(),
        "measured": MEASURED[since:], "measured_to": len(MEASURED),
    })
    return f"{label} ({view})"


OPS = {
    "add": op_add,
    "mesh": op_mesh,
    "shade": op_shade,
    "normals": op_normals,
    "look": op_look,
    "reference": op_reference,
    "render_view": op_render_view,
    "select": op_select,
    "crease": op_crease,
    "inset": op_inset,
    "extrude": op_extrude,
    "bevel_edges": op_bevel_edges,
    "loop_cut": op_loop_cut,
    "delete_faces": op_delete_faces,
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
            # A slot can exist and hold nothing. Booleans and inset/extrude
            # both leave empty slots behind, and reading .name off one took
            # down the whole result -- after every operation had succeeded.
            "material": next((m.name for m in getattr(o.data, "materials", None) or [] if m), None),
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

    # Read-only batches do not write the file.
    #
    # Every successful run used to save, so asking a model a question --
    # measure its bounds, look at it, render a view -- rewrote the .blend. The
    # watching viewer sees the mtime move and reverts, which means repeatedly
    # measuring a model made its window reload over and over for no change at
    # all. A question should not modify the thing it is asking about.
    READONLY = {"measure", "assert", "look", "render_view"}
    touched = any(o.get("op") not in READONLY for o in req.get("ops", []))

    # Saved only when every operation succeeded. A half-applied batch is worse
    # than a rejected one: the agent would be reasoning about a scene that
    # matches neither what it asked for nor what it last saw.
    if not errors and touched:
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
        "measured": MEASURED, "checkpoints": CHECKPOINTS,
    }))


main()
