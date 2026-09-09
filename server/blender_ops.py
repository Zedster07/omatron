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
    elif kind == "shrinkwrap":
        # Conform one surface onto another -- how a panel, a decal or a trim
        # strip is made to sit exactly on a curved body.
        m = ob.modifiers.new(name="Shrinkwrap", type="SHRINKWRAP")
        m.target = _obj(o["to"])
        m.offset = float(o.get("offset", 0.0))
        m.wrap_method = str(o.get("method", "NEAREST_SURFACEPOINT")).upper()
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


# Named materials, because "roughness 0.3, metallic 0.5" is not a car's paint.
#
# Most of whether a render reads as convincing is shading, not geometry. The
# same body lit and shaded properly looks like a product; flat, it looks like a
# grey blob -- demonstrated on the same mesh in one session. These are the
# handful of surfaces this tool is actually asked for, with the parameters that
# make each read correctly, rather than four sliders and good luck.
FINISHES = {
    #                base color            rough  metal  coat  transmission
    "paint":        ((0.42, 0.06, 0.08),   0.28,  0.45,  0.75, 0.0),
    "matte_paint":  ((0.30, 0.31, 0.34),   0.62,  0.10,  0.00, 0.0),
    "rubber":       ((0.021, 0.021, 0.024), 0.92, 0.00,  0.00, 0.0),
    "glass":        ((0.86, 0.90, 0.93),   0.03,  0.00,  0.20, 0.92),
    "tinted_glass": ((0.10, 0.13, 0.16),   0.05,  0.00,  0.25, 0.62),
    "chrome":       ((0.92, 0.93, 0.95),   0.04,  1.00,  0.00, 0.0),
    "alloy":        ((0.70, 0.71, 0.74),   0.22,  1.00,  0.00, 0.0),
    "brushed":      ((0.62, 0.63, 0.66),   0.38,  1.00,  0.00, 0.0),
    "plastic":      ((0.08, 0.08, 0.09),   0.48,  0.00,  0.05, 0.0),
    "lens":         ((0.90, 0.92, 0.96),   0.05,  0.10,  0.60, 0.55),
    "steel":        ((0.55, 0.56, 0.58),   0.30,  1.00,  0.00, 0.0),
}


def op_material(o):
    ob = _obj(o["name"])
    mat = bpy.data.materials.new(name=o.get("material", "Material"))
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")

    finish = str(o.get("finish", "")).lower()
    if finish and finish not in FINISHES:
        raise ValueError(f"unknown finish {finish!r}; try {', '.join(sorted(FINISHES))}")
    if finish:
        base, rough, metal, coat, trans = FINISHES[finish]
    else:
        base, rough, metal, coat, trans = (0.8, 0.8, 0.8), 0.5, 0.0, 0.0, 0.0

    c = o.get("color", base)                       # colour overrides the preset's
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (float(c[0]), float(c[1]), float(c[2]), 1.0)
        bsdf.inputs["Roughness"].default_value = float(o.get("roughness", rough))
        bsdf.inputs["Metallic"].default_value = float(o.get("metallic", metal))
        # Input names moved between Blender versions, and a missing one is a
        # silent no-op rather than an error -- so ask for whichever exists.
        for names, value in (
                (("Coat Weight", "Clearcoat"), float(o.get("coat", coat))),
                (("Transmission Weight", "Transmission"), float(o.get("transmission", trans))),
                (("IOR",), float(o.get("ior", 1.45)))):
            for n in names:
                if n in bsdf.inputs:
                    bsdf.inputs[n].default_value = value
                    break
    if trans > 0.5:
        mat.blend_method = "BLEND" if hasattr(mat, "blend_method") else mat.blend_method
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return f"{ob.name}: {mat.name}" + (f" ({finish})" if finish else "")


def op_transform_check(o):
    """Scale and rotation must be applied. No exceptions.

    A production rule this project kept breaking. An object carrying a scale
    of, say, (1.6, 1.0, 0.3) renders correctly and then betrays you: modifiers
    read it, normals shear under non-uniform scale, bevel widths come out
    different on each axis, and every exporter bakes something different. It is
    the classic silent-wrong. This bakes the transform into the mesh.
    """
    ob = _obj(o["name"])
    before = tuple(round(v, 4) for v in ob.scale)
    bpy.context.view_layer.objects.active = ob
    for other in bpy.context.selected_objects:
        other.select_set(False)
    ob.select_set(True)
    bpy.ops.object.transform_apply(location=bool(o.get("location", False)),
                                   rotation=bool(o.get("rotation", True)),
                                   scale=bool(o.get("scale", True)))
    ob.select_set(False)
    return f"{ob.name}: applied, was scale {before}"


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
            if not _subject(ob):
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

    if what == "transform":
        # "Always apply scale and rotation before export. No exceptions." --
        # a rule this project broke repeatedly and then wondered why bevels
        # came out uneven and normals sheared.
        ob = _obj(o["name"])
        sc = [round(v, 5) for v in ob.scale]
        rot = [round(math.degrees(v), 3) for v in ob.rotation_euler]
        uniform = max(sc) - min(sc) < 1e-4
        return {"what": "transform", "name": o["name"], "scale": sc,
                "rotation_deg": rot, "uniform_scale": uniform,
                "scale_applied": all(abs(v - 1.0) < 1e-4 for v in sc),
                "rotation_applied": all(abs(v) < 1e-3 for v in rot)}

    if what == "references":
        # The setup, checked like everything else is.
        #
        # Three drawings OVER-DETERMINE the car: side and top both measure its
        # length, front and top both measure its width, side and front both
        # measure its height. Any disagreement means a reference is wrong --
        # mis-scaled, mis-cropped, or attached to the wrong view -- and that is
        # knowable before a single vertex exists.
        #
        # This layer had assertions for every property of a MODEL and none for
        # the drawings the model is built from, which is how three placement
        # bugs survived: each was correct in the one view it was written
        # against and nothing ever compared them.
        #
        #   view    across the drawing   up the drawing
        #   side    length               height
        #   front   width                height
        #   top     length               width
        got = {}
        for view in _VIEWS:
            raw = bpy.context.scene.get(f"omatron_ref_{view}")
            if not raw:
                continue
            try:
                cal = json.loads(raw)
            except (TypeError, ValueError):
                got[view] = {"error": "uncalibrated (attached by an older version)"}
                continue
            x0, x1, ylo, yhi = cal["px"]
            mpp = cal["mpp"]
            ob = bpy.data.objects.get(f"Reference_{view}")
            got[view] = {
                "mm_per_px": round(mpp * 1000, 4),
                "across": round((x1 - x0 + 1) * mpp, 4),
                "up": round((yhi - ylo + 1) * mpp, 4),
                "plate_at": ([round(v, 4) for v in ob.location] if ob else None),
                "image": os.path.basename(cal["path"]),
            }

        claims = {"length": [], "width": [], "height": []}
        for view, g in got.items():
            if "error" in g:
                continue
            if view == "side":
                claims["length"].append(("side", g["across"]))
                claims["height"].append(("side", g["up"]))
            elif view == "front":
                claims["width"].append(("front", g["across"]))
                claims["height"].append(("front", g["up"]))
            elif view == "top":
                claims["length"].append(("top", g["across"]))
                claims["width"].append(("top", g["up"]))

        agree = {}
        for dim, vals in claims.items():
            if len(vals) < 2:
                agree[dim] = {"sources": [v[0] for v in vals], "checked": False}
                continue
            lo = min(v[1] for v in vals)
            hi = max(v[1] for v in vals)
            agree[dim] = {"sources": {v[0]: v[1] for v in vals},
                          "spread": round((hi - lo) / max(hi, 1e-9), 4), "checked": True}

        return {"what": "references", "views": got, "agreement": agree}

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

    elif what == "transform":
        if o.get("uniform_scale") and not m["uniform_scale"]:
            raise ValueError(
                f"{o['name']} has non-uniform scale {m['scale']} — normals shear, bevel "
                "widths differ per axis, and every exporter bakes it differently. "
                'Apply it: {"op":"apply_transform","name":"' + str(o["name"]) + '"}')
        if o.get("applied") and not (m["scale_applied"] and m["rotation_applied"]):
            raise ValueError(
                f"{o['name']} carries an unapplied transform (scale {m['scale']}, "
                f"rotation {m['rotation_deg']}). Apply it before relying on modifiers "
                "or exporting.")
    elif what == "references":
        need = [v for v in (o.get("views") or []) if v not in m["views"]]
        if need:
            raise ValueError(
                f"no reference attached for: {', '.join(need)}. "
                "A dimension no drawing describes is a dimension you are inventing.")
        tol = float(o.get("agree", 0.03))
        for dim, a in m["agreement"].items():
            if not a["checked"]:
                continue
            if a["spread"] > tol:
                pairs = ", ".join(f"{k} says {v:.3f} m" for k, v in a["sources"].items())
                raise ValueError(
                    f"the drawings disagree about {dim} by {a['spread'] * 100:.1f}%: {pairs}. "
                    "One of them is mis-scaled, mis-cropped, or attached to the wrong view -- "
                    "and every measurement taken from it will be wrong in the same proportion.")
        for view, g in m["views"].items():
            if "error" in g:
                raise ValueError(f"the {view} reference is {g['error']}")
            at = g.get("plate_at")
            if not at:
                continue
            # Where each plate must sit, which is the check that would have
            # caught a top view anchored on a ground line it does not have.
            if view == "top" and abs(at[1]) > 0.02:
                raise ValueError(
                    f"the top plate sits at y={at[1]:.3f} instead of on the centreline. A plan "
                    "view has no ground edge to rest on -- it must be CENTRED, and one anchored "
                    "like a side view lands half a car's width out.")
            if view in ("side", "front") and abs(at[0 if view == "side" else 1]) > 0.02:
                raise ValueError(f"the {view} plate is not centred across the car (at {at})")
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
    for v in bm.verts:
        v.select = False
    if want in ("faces", "both"):
        for f in faces:
            f.select = True
    if want in ("edges", "both", "verts"):
        for e in edges:
            e.select = True
    # Vertices follow whatever was picked, so `move` has something to grab
    # whichever mode the caller chose.
    for e in edges if want in ("edges", "both", "verts") else []:
        e.verts[0].select = True
        e.verts[1].select = True
    for f in faces if want in ("faces", "both") else []:
        for v in f.verts:
            v.select = True

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

    # Clearing has to be possible, and deleting the plate is NOT clearing.
    #
    # The calibration lives on the scene, not on the empty, so removing the
    # Reference_top object left its measurements in place -- and the next loft
    # silently used a previous car's top and front views while reporting
    # "side+top+front" as though all three belonged together. Every number it
    # produced was wrong and none of them looked it.
    if o.get("clear"):
        for key in (f"omatron_ref_{view}", f"omatron_trace_{view}"):
            if key in bpy.context.scene:
                del bpy.context.scene[key]
        old_ob = bpy.data.objects.get(f"Reference_{view}")
        if old_ob:
            bpy.data.objects.remove(old_ob, do_unlink=True)
        return f"{view}: cleared"

    if "image" not in o:
        raise ValueError("give an image, or clear:true to drop this view's reference")
    path = os.path.expanduser(str(o["image"]))
    if not os.path.exists(path):
        raise ValueError(f"no such reference image: {path}")

    # The horizontal span means something different per view -- length in a
    # side or top view, width in a front view -- so accept whichever word fits
    # and treat them all as "across the drawing".
    across = o.get("length") or o.get("width") or o.get("across")
    height = o.get("height")

    # Calibrate against a view already attached, rather than a number from a
    # spec sheet.
    #
    # Three drawings share dimensions -- side and top both span the length,
    # front and top both span the width, side and front both span the height.
    # Scaling one from a published figure while its neighbours are scaled from
    # the drawing puts them out of step: a front view given the Cobra's real
    # 1.727 m width sat 3.2% wide of the top view's own 1.673 m, and every
    # width taken from it inherited that error. Matching keeps the set
    # self-consistent, which is what actually matters -- the drawings only have
    # to agree with EACH OTHER to build a coherent model.
    SHARED = {("front", "top"): ("across", "up"),      # width
              ("front", "side"): ("up", "up"),         # height
              ("top", "side"): ("across", "across"),   # length
              ("top", "front"): ("up", "across"),
              ("side", "top"): ("across", "across"),
              ("side", "front"): ("up", "up")}
    if o.get("match"):
        other = str(o["match"]).lower()
        key = (view, other)
        if key not in SHARED:
            raise ValueError(f"cannot take a dimension from the {other} view for a {view} view")
        mine, theirs = SHARED[key]
        raw = bpy.context.scene.get(f"omatron_ref_{other}")
        if not raw:
            raise ValueError(f"no {other} reference attached to match against — attach it first")
        cal = json.loads(raw)
        x0, x1, ylo, yhi = cal["px"]
        value = ((x1 - x0 + 1) if theirs == "across" else (yhi - ylo + 1)) * cal["mpp"]
        if mine == "across":
            across, height = value, None
        else:
            across, height = None, value

    if not across and not height:
        raise ValueError(
            "give the real size of the drawn vehicle: length/width (across the "
            "drawing) or height. Without it the drawing has no scale, and a "
            "reference with no scale cannot be compared against or laid under "
            "anything.")
    length = across

    # Drawings arrive in whatever orientation the draughtsman chose.
    #
    # A plan view of a car runs lengthwise; a plan view of an aircraft is very
    # often drawn nose-up, so its horizontal span is the WINGSPAN. Reading it
    # as a length silently scrambles every dimension downstream -- and the
    # cross-view check caught exactly that on an SK-1 sheet, 23.5% out on
    # height, before anything was built.
    turn = int(o.get("rotate", 0)) % 360
    if turn not in (0, 90, 180, 270):
        raise ValueError("rotate is 0, 90, 180 or 270 degrees")

    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        mask = _fill_holes(_mask_from_pixels(img.pixels[:], w, h))
    finally:
        bpy.data.images.remove(img)

    if turn:
        import numpy as np
        # k is negated because Blender hands pixels back bottom-up, so a
        # clockwise turn on screen is a counter-clockwise turn in this array.
        mask = np.rot90(mask, k=-(turn // 90))
        if turn in (90, 270):
            w, h = h, w

    import numpy as np
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if not len(rows) or not len(cols):
        raise ValueError(f"{os.path.basename(path)} has no visible outline to measure")
    # Blender hands back pixels bottom-up; row 0 is the BOTTOM of the image.
    x0, x1, ylo, yhi = int(cols[0]), int(cols[-1]), int(rows[0]), int(rows[-1])
    mpp = (float(length) / (x1 - x0 + 1)) if length else (float(height) / (yhi - ylo + 1))

    cal = {"path": path, "mpp": mpp, "px": [x0, x1, ylo, yhi], "size": [w, h],
           "rotate": turn}
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
        # The vertical edge means different things per view.
        #
        # In a side or front view the outline's bottom edge is the GROUND, so
        # it belongs on z=0. A top view has no ground: it looks down at a car
        # that is symmetric about its centreline, so it belongs CENTRED on
        # y=0. Bottom-aligning it there shoved the whole drawing sideways by
        # half the car's width -- 0.834 m, which is exactly what it looked
        # like: a plan view that would not line up with anything.
        anchor = ((ylo + yhi) / 2.0) if view == "top" else ylo
        off_z = (anchor / h - 0.5) * world_h
        base = mathutils.Euler(_VIEWS[view][1], "XYZ").to_matrix()
        if turn:
            base = base @ mathutils.Matrix.Rotation(math.radians(turn), 3, "Z")
        empty.rotation_euler = base.to_euler()
        # Stand the plate back along the direction this view LOOKS, not along Y
        # for every view. Offsetting a front-view plate on Y pushes it sideways
        # out of the car instead of in front of it, so the drawing you are
        # meant to be lining the model up against sits beside it.
        look = mathutils.Vector(_VIEWS[view][0])
        back = look * float(o.get("depth", 1.2))
        # The plate's own axes: local X across, local Y up, per the rotation.
        empty.location = base @ mathutils.Vector((-off_x, -off_z, 0.0)) + back
        empty.hide_render = True
        bpy.context.scene.collection.objects.link(empty)
    except Exception:
        pass

    return (f"{view}: {os.path.basename(path)} — outline {(x1 - x0 + 1) * mpp:.2f} x "
            f"{(yhi - ylo + 1) * mpp:.2f} m at {mpp * 1000:.2f} mm/px"
            + (f", matched to {o['match']}" if o.get("match") else "")
            + (f", turned {turn}deg" if turn else ""))


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
        if not _subject(ob):
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
        if not _subject(ob):
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


# ------------------------------------------- reading shape out of the drawings
#
# One view fixes one plane. A side blueprint pins the profile and says nothing
# about width, so the first car fitted to one had a measured roofline and a
# plan view invented by a taper() function -- which is most of what you see
# from any angle that is not directly side-on.
#
# Three views together give: length and height from the side, width along the
# length from the top, and the shape of the cross-section from the front. That
# last one is the real prize. It is the only one of the three that describes
# the section itself rather than an extent, and it is what stops every station
# being the same invented oval.
#
# What three views CANNOT give is the visual hull problem: the intersection of
# three extrusions is fatter than the object, and no orthographic outline
# records a crease. This gets you a far better blockout, not a finished
# surface.

def _reference_mask(view):
    """The drawing's filled outline, plus the calibration to place it."""
    raw = bpy.context.scene.get(f"omatron_ref_{view}")
    if not raw:
        raise ValueError(
            f'no {view} reference attached. {{"op":"reference","view":"{view}",'
            '"image":"...","length":4.17}')
    try:
        cal = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError(f"the {view} reference predates calibration; attach it again with a size")
    img = bpy.data.images.load(os.path.expanduser(cal["path"]), check_existing=False)
    try:
        mask = _fill_holes(_mask_from_pixels(img.pixels[:], *img.size))
    finally:
        bpy.data.images.remove(img)
    # The same turn the calibration was measured through, or every consumer of
    # this mask -- trace, silhouette -- reads a drawing at odds with the
    # numbers describing it.
    turn = int(cal.get("rotate", 0)) % 360
    if turn:
        import numpy as np
        mask = np.rot90(mask, k=-(turn // 90))
    return mask, cal


def _trace_view(view, n, floor=None):
    """Sample a drawing's outline into n slices across it.

    Returns world-space (lo, hi) per slice: z above the ground for a side or
    front view, y either side of centre for a top view.
    """
    import numpy as np
    mask, cal = _reference_mask(view)
    mpp = cal["mpp"]
    x0, x1, ylo, yhi = cal["px"]
    cx = (x0 + x1) / 2.0

    cols = np.linspace(x0 + 1, x1 - 1, n).astype("int32")
    out = []
    for c in cols:
        rows = np.where(mask[:, c])[0]
        if not len(rows):
            out.append(None)
            continue
        # Blender pixels are bottom-up, so row index rises with height.
        lo, hi = float(rows.min()), float(rows.max())
        if view == "top":
            # Across a top view, the two edges straddle the centreline.
            mid = (ylo + yhi) / 2.0
            out.append(((lo - mid) * mpp, (hi - mid) * mpp))
        else:
            out.append(((lo - ylo) * mpp, (hi - ylo) * mpp))

    if floor == "sill" and view != "top":
        # A side view's lower edge is the TYRES wherever there is a wheel, and
        # the body's underside everywhere else. Lofting to it drags the body
        # down to the road at each axle. The sill is the highest that lower
        # edge gets across the middle of the car -- between the wheels, where
        # the outline IS the underbody -- and no part of the body sits below
        # it, so raising every slice to at least that height removes the wheels
        # from the body's profile and keeps the nose and tail rising away.
        mid = [v for i, v in enumerate(out)
               if v and 0.3 < i / max(len(out) - 1, 1) < 0.7]
        if mid:
            sill = max(v[0] for v in mid)
            out = [None if v is None else (max(v[0], sill), v[1]) for v in out]

    span = ((x0 - cx) * mpp, (x1 - cx) * mpp)
    return {"view": view, "span": span, "slices": out}


def op_trace(o):
    """Measure a reference's outline and keep it for lofting."""
    view = str(o.get("view", "side")).lower()
    n = max(4, min(int(o.get("stations", 24)), 120))
    t = _trace_view(view, n, o.get("floor"))
    bpy.context.scene[f"omatron_trace_{view}"] = json.dumps(t)
    good = [s for s in t["slices"] if s]
    if not good:
        raise ValueError(f"the {view} drawing has no outline to trace")
    lo = min(s[0] for s in good)
    hi = max(s[1] for s in good)
    return (f"{view}: {n} slices over {t['span'][1] - t['span'][0]:.2f} m, "
            f"cross extent {lo:.2f} to {hi:.2f} m")


def _section_shape(samples=24, start=0.0, end=1.0):
    """Half-width as a fraction of the maximum, up the height of the car.

    Taken from the FRONT view, this is the actual cross-section of the body --
    wide at the shoulders, drawn in at the roof, tucked under at the sills. It
    replaces the invented taper that made every previous car a lozenge. Without
    a front reference, fall back to a rounded default and say so.
    """
    import numpy as np
    try:
        mask, cal = _reference_mask("front")
    except ValueError:
        lift = 1.0 / (samples + 1)
        body = [(k / (samples - 1),
                 math.sin(math.pi * (0.18 + 0.82 * k / (samples - 1))) ** 0.40)
                for k in range(samples)]
        return ([(0.0, 0.0)]
                + [(lift + f * (1.0 - 2 * lift), w) for f, w in body]
                + [(1.0, 0.0)]), False

    x0, x1, ylo, yhi = cal["px"]
    # `start` skips the bottom of the front view -- the tyres and the gap under
    # the car, which are not the body's cross-section. Without it the body is
    # as wide as the track at ground level, i.e. a slab on wheels.
    # `start` trims running gear off the bottom; `end` trims what is above the
    # bodywork off the top. On this Cobra the front view's upper third is the
    # WINDSCREEN -- narrow, and correct for the cockpit and wrong everywhere
    # else. Applied to every station it put a narrow ridge along the bonnet and
    # the boot, which is what turned the loft into a lumpy log.
    span = yhi - ylo
    lo_row = ylo + span * max(0.0, min(start, 0.8))
    hi_row = ylo + span * max(min(end, 1.0), start + 0.1)
    rows = np.linspace(lo_row + 1, hi_row - 1, samples).astype("int32")
    widths = []
    for r in rows:
        cols = np.where(mask[r, :])[0]
        widths.append(0.0 if not len(cols) else float(cols.max() - cols.min()) / 2.0)
    peak = max(widths) or 1.0
    body = [(k / (samples - 1), widths[k] / peak) for k in range(samples)]

    # Close the section by ADDING centreline points, not by flattening the ones
    # at the ends.
    #
    # The half-body must reach y=0 or the mirror makes two detached shells --
    # but zeroing the first and last samples throws away the true width of the
    # floor and the roof, and a section that is a point at the bottom, wide in
    # the middle and a point at the top is a LENS. Lofted along a car it gives
    # a log, which is exactly what it gave. A real section is closed at the
    # centreline AND flat across the floor: keep the measured widths, and add
    # the two centreline points around them.
    lift = 1.0 / (samples + 1)
    shape = ([(0.0, 0.0)]
             + [(lift + f * (1.0 - 2 * lift), w) for f, w in body]
             + [(1.0, 0.0)])
    return shape, True


def op_loft(o):
    """Build a body from the traced drawings.

    Declarative on purpose: the caller gives station count and a few
    proportions, and the looping happens here. Emitting 154 vertices as literal
    JSON is not something to ask of anything that has to reason about them.
    """
    name = str(o.get("name", "Body"))
    n = max(6, min(int(o.get("stations", 24)), 100))

    side = _trace_view("side", n, o.get("floor", "sill"))
    try:
        top = _trace_view("top", n)
        have_top = True
    except ValueError:
        top, have_top = None, False
    shape, have_front = _section_shape(int(o.get("ring", 16)),
                                       float(o.get("section_from", 0.0)),
                                       float(o.get("section_to", 1.0)))

    width = float(o.get("width", 1.72)) / 2.0     # used when there is no top view
    ring = len(shape)
    verts, faces = [], []
    x_lo, x_hi = side["span"]

    for i, sl in enumerate(side["slices"]):
        if sl is None:
            sl = (0.0, 0.01)
        zb, zt = sl
        x = x_lo + (x_hi - x_lo) * i / (n - 1)
        if have_top and top["slices"][i]:
            tlo, thi = top["slices"][i]
            half = max(abs(tlo), abs(thi))
        else:
            t = i / (n - 1)
            half = width * (0.55 + 0.45 * math.sin(math.pi * t) ** 0.3)
        for f, wf in shape:
            verts.append((x, half * wf, zb + (zt - zb) * f))

    for i in range(n - 1):
        a, b = i * ring, (i + 1) * ring
        for k in range(ring - 1):
            faces.append((a + k, a + k + 1, b + k + 1, b + k))
    faces.append(tuple(range(ring - 1, -1, -1)))
    faces.append(tuple(range(len(verts) - ring, len(verts))))

    res = op_mesh({"name": name, "verts": verts, "faces": faces})
    op_normals({"name": name})
    # The loft builds the y >= 0 half; a mirror owns the rest. Without this the
    # body is an open half-tube that measures, renders and reads as a car from
    # exactly one side.
    if o.get("mirror", True):
        op_modifier({"name": name, "kind": "mirror", "axis": "y"})
    src = ("side+top+front" if (have_top and have_front)
           else "side+top" if have_top else "side+front" if have_front else "side only")
    note = "" if (have_top and have_front) else \
        f"  [{'no top view: widths along the length are estimated. ' if not have_top else ''}" \
        f"{'no front view: the cross-section shape is a guess, which is the ' if not have_front else ''}" \
        f"{'thing three views exist to fix' if not have_front else ''}]"
    return f"{res} from {src}{note}"


def op_studio(o):
    """Three-point lighting, a gradient sky and a floor.

    Included because shading, not geometry, is most of whether a render reads
    as convincing -- proved on one mesh in one session, where the same body went
    from grey lump to product shot on lighting alone. The default stage exists
    to make a model VISIBLE; this exists to make it look like something.
    """
    scn = bpy.context.scene
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    nt = scn.world.node_tree
    bg = nt.nodes.get("Background")
    if bg and o.get("gradient", True):
        for n in list(nt.nodes):
            if n.type in {"TEX_GRADIENT", "TEX_COORD", "VALTORGB"}:
                nt.nodes.remove(n)
        tex = nt.nodes.new("ShaderNodeTexCoord")
        grad = nt.nodes.new("ShaderNodeTexGradient")
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        lo = o.get("sky_low", [0.02, 0.025, 0.035])
        hi = o.get("sky_high", [0.55, 0.60, 0.68])
        ramp.color_ramp.elements[0].color = (*lo, 1)
        ramp.color_ramp.elements[1].color = (*hi, 1)
        nt.links.new(tex.outputs["Generated"], grad.inputs["Vector"])
        nt.links.new(grad.outputs["Color"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    if bg:
        bg.inputs["Strength"].default_value = float(o.get("sky_strength", 1.0))

    for ob in [x for x in bpy.data.objects if x.type == "LIGHT"]:
        bpy.data.objects.remove(ob, do_unlink=True)

    dg = bpy.context.evaluated_depsgraph_get()
    lo_b, hi_b = None, None
    for ob in bpy.data.objects:
        if not _subject(ob):
            continue
        a, b = _bounds(ob, dg)
        lo_b = a if lo_b is None else [min(lo_b[i], a[i]) for i in range(3)]
        hi_b = b if hi_b is None else [max(hi_b[i], b[i]) for i in range(3)]
    span = max(hi_b[i] - lo_b[i] for i in range(3)) if lo_b else 2.0
    cz = ((lo_b[2] + hi_b[2]) / 2) if lo_b else 1.0

    # Scaled to the subject: a fixed rig blows out a ring and underlights a car.
    power = float(o.get("power", 1.0)) * span * span
    for loc, energy, size, rot in (
            ((span * 0.9, -span * 1.4, span * 1.25), 55 * power, span * 1.8,
             (math.radians(48), 0, math.radians(28))),
            ((-span * 1.5, -span * 0.8, span * 0.8), 18 * power, span * 2.2,
             (math.radians(64), 0, math.radians(-52))),
            ((span * 0.1, span * 1.6, span * 1.0), 28 * power, span * 2.0,
             (math.radians(-58), 0, 0))):
        bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
        L = bpy.context.active_object
        L.data.energy = energy
        L.data.size = size

    if o.get("floor", True):
        existing = bpy.data.objects.get("StudioFloor")
        if existing:
            bpy.data.objects.remove(existing, do_unlink=True)
        bpy.ops.mesh.primitive_plane_add(size=span * 6,
                                         location=(0, 0, lo_b[2] if lo_b else 0.0))
        f = bpy.context.active_object
        f.name = "StudioFloor"
        f["omatron_helper"] = True
        op_material({"name": "StudioFloor", "material": "Floor",
                     "finish": "matte_paint",
                     "color": o.get("floor_color", [0.16, 0.17, 0.19])})
    return f"studio: 3 lights scaled to a {span:.2f} m subject"


# ------------------------------------------------------- modelling, properly
#
# Everything above selects by REGION and by NORMAL, which is a spatial query --
# useful for "the faces on the nose", useless for the way modelling actually
# works. A modeller works in loops and rings: pick an edge, run the loop all
# the way round the form, and operate on that. Every panel line, every support
# loop, every bridge between two openings is a loop operation, and none of them
# is expressible as a bounding box.
#
# And a whole class of shapes was simply unreachable. Anything turned on an
# axis -- a rim, a flange, a bottle, a vase, a pulley -- is a profile revolved,
# and no arrangement of primitives and booleans substitutes for that.

def _seed_edge(bm, mw, near):
    """The edge nearest a world point. How you name an edge without an index."""
    p = mathutils.Vector(near)
    best, bd = None, None
    for e in bm.edges:
        m = mw @ ((e.verts[0].co + e.verts[1].co) / 2.0)
        d = (m - p).length
        if bd is None or d < bd:
            best, bd = e, d
    return best, bd


def _walk_loop(seed, ring=False):
    """Follow an edge loop (or ring) from a seed edge.

    A loop continues through a vertex of valence four, taking the edge
    'opposite' the one it arrived on. A ring steps sideways across quads
    instead. Both stop at a pole or a boundary, which is exactly where a
    modeller's loop select stops too.
    """
    out, seen = [seed], {seed}
    if ring:
        for direction in (0, 1):
            e, f = seed, None
            faces = list(seed.link_faces)
            if not faces:
                break
            f = faces[direction] if len(faces) > direction else faces[0]
            while True:
                if f is None or len(f.verts) != 4:
                    break
                opp = None
                fe = list(f.edges)
                i = fe.index(e) if e in fe else None
                if i is None:
                    break
                opp = fe[(i + 2) % 4]
                if opp in seen:
                    break
                out.append(opp); seen.add(opp)
                nxt = [g for g in opp.link_faces if g is not f]
                e, f = opp, (nxt[0] if nxt else None)
        return out

    for v_start in (seed.verts[0], seed.verts[1]):
        e, v = seed, v_start
        while True:
            if len(v.link_edges) != 4:
                break
            # the edge across the vertex: not e, and not sharing a face with e
            cands = [x for x in v.link_edges if x is not e]
            opp = None
            for c in cands:
                if not set(c.link_faces) & set(e.link_faces):
                    opp = c
                    break
            if opp is None or opp in seen:
                break
            out.append(opp); seen.add(opp)
            v = opp.other_vert(v)
            e = opp
    return out


def op_select_loop(o):
    """Select an edge loop or ring, named by a point near it."""
    ob = _obj(o["name"])
    bm = _open(ob)
    seed, dist = _seed_edge(bm, ob.matrix_world, _vec(o["near"]))
    if seed is None:
        bm.free()
        raise ValueError(f"{ob.name} has no edges")
    edges = _walk_loop(seed, ring=bool(o.get("ring", False)))
    for e in bm.edges:
        e.select = False
    for f in bm.faces:
        f.select = False
    for e in edges:
        e.select = True
    n = len(edges)
    _close(bm, ob)
    return (f"{ob.name}: {'ring' if o.get('ring') else 'loop'} of {n} edge(s), "
            f"seeded {dist:.3f} m from the point given")


def op_revolve(o):
    """Turn a profile around an axis. The operation this had no substitute for.

    A rim, a flange, a bottle, a wheel hub, a pulley -- every one of them is a
    2D profile spun about a line, and every one of them was previously
    approximated with stacked cylinders.
    """
    prof = [tuple(float(c) for c in v) for v in o["profile"]]
    if len(prof) < 2:
        raise ValueError("a profile needs at least two points, as [x, y, z] triples")
    axis = _vec(o.get("axis"), (0.0, 0.0, 1.0))
    centre = _vec(o.get("at"))
    steps = max(3, min(int(o.get("steps", 32)), 512))
    angle = math.radians(float(o.get("degrees", 360.0)))
    close = abs(angle - 2 * math.pi) < 1e-6

    import bmesh
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in prof]
    for a, b in zip(verts, verts[1:]):
        bm.edges.new((a, b))
    bmesh.ops.spin(bm, geom=verts + bm.edges[:], cent=centre,
                   axis=mathutils.Vector(axis).normalized(),
                   dvec=(0, 0, 0), angle=angle, steps=steps,
                   use_merge=close, use_duplicate=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    me = bpy.data.meshes.new(o.get("name", "Revolved"))
    bm.to_mesh(me); bm.free(); me.update()
    ob = bpy.data.objects.new(o.get("name", "Revolved"), me)
    bpy.context.collection.objects.link(ob)
    return f"{ob.name} ({len(me.vertices)} verts, {len(me.polygons)} faces)"


def op_bridge(o):
    """Join the selected edge loops with a surface between them."""
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = _require(_selected(bm, "edges"), "bridge", o)
    try:
        bmesh.ops.bridge_loops(bm, edges=sel, use_pairs=bool(o.get("pairs", False)))
    except RuntimeError as e:
        bm.free()
        raise ValueError(
            f"cannot bridge those edges ({e}). Bridging wants two separate closed "
            "loops with nothing between them -- select one loop, then the other.")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    _close(bm, ob)
    return f"{ob.name}: bridged {len(sel)} edge(s)"


def op_separate(o):
    """Split the selected faces into an object of their own -- panels, parts."""
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = _require(_selected(bm, "faces"), "separate", o)
    verts = {v for f in sel for v in f.verts}
    vmap = {}
    nbm = bmesh.new()
    for v in verts:
        vmap[v] = nbm.verts.new(v.co)
    nbm.verts.index_update()
    for f in sel:
        try:
            nbm.faces.new([vmap[v] for v in f.verts])
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(nbm, faces=nbm.faces)
    me = bpy.data.meshes.new(o.get("to", ob.name + "_part"))
    nbm.to_mesh(me); nbm.free(); me.update()
    new = bpy.data.objects.new(o.get("to", ob.name + "_part"), me)
    new.matrix_world = ob.matrix_world.copy()
    bpy.context.collection.objects.link(new)
    if o.get("keep", False) is False:
        bmesh.ops.delete(bm, geom=sel, context="FACES")
    _close(bm, ob)
    return f"{new.name}: {len(me.polygons)} face(s) taken from {ob.name}"


def op_clean(o):
    """Merge doubles, dissolve stray edges, drop loose geometry.

    The tidy-up every mesh needs after booleans, and the thing that decides
    whether subdivision behaves.
    """
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    before = (len(bm.verts), len(bm.faces))
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=float(o.get("distance", 1e-4)))
    loose = [v for v in bm.verts if not v.link_edges]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    if o.get("dissolve_flat"):
        lim = math.radians(float(o["dissolve_flat"]))
        flat = [e for e in bm.edges
                if len(e.link_faces) == 2 and e.calc_face_angle(0.0) < lim]
        if flat:
            bmesh.ops.dissolve_edges(bm, edges=flat, use_verts=True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    after = (len(bm.verts), len(bm.faces))
    _close(bm, ob)
    return (f"{ob.name}: {before[0]}->{after[0]} verts, {before[1]}->{after[1]} faces")


def op_smooth(o):
    """Relax the selected vertices. Takes lumps out without moving the form."""
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = ([v for v in bm.verts if v.select]
           if o.get("only_selected") else bm.verts[:])
    if not sel:
        bm.free()
        raise ValueError(f"nothing selected on {ob.name} to smooth")
    for _ in range(max(1, min(int(o.get("iterations", 2)), 20))):
        bmesh.ops.smooth_vert(bm, verts=sel, factor=float(o.get("factor", 0.5)),
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    _close(bm, ob)
    return f"{ob.name}: relaxed {len(sel)} vert(s)"


def _sel_verts(bm):
    """The vertices under the current selection, however it was made."""
    verts = {v for v in bm.verts if v.select}
    for e in bm.edges:
        if e.select:
            verts.update(e.verts)
    for f in bm.faces:
        if f.select:
            verts.update(f.verts)
    return list(verts)


def op_move(o):
    """Push and pull the selection. The most basic modelling action there is.

    Everything else here ADDS geometry or CUTS it -- extrude, inset, bevel,
    boolean. None of them shape what is already there. A modeller spends most
    of their time grabbing something and moving it, and without this the tool
    could build a form and then never adjust one.

    Works in world space on the vertices under the selection, whether that
    selection was made by region, by normal, or by walking a loop.
    """
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    verts = _require(_sel_verts(bm), "move", o)
    mw = ob.matrix_world
    inv = mw.inverted_safe()

    if "along_normal" in o:
        # Along the surface, rather than along an axis. What "pull this out"
        # means on a curved body, where no world axis is the right direction.
        d = float(o["along_normal"])
        n = mathutils.Vector((0, 0, 0))
        for f in bm.faces:
            if f.select:
                n += f.normal
        if n.length < 1e-9:
            for v in verts:
                n += v.normal
        if n.length < 1e-9:
            bm.free()
            raise ValueError(
                "the selection has no consistent normal to move along -- it faces "
                "opposing ways. Give an explicit offset [x,y,z] instead.")
        offset = (mw.to_3x3() @ n.normalized()) * d
    else:
        offset = mathutils.Vector(_vec(o.get("offset")))

    centre = mathutils.Vector(_vec(o["about"])) if "about" in o else None
    if centre is None and ("scale" in o or "rotate_deg" in o):
        # Default pivot is the selection's own middle, which is what "scale
        # this up" means when nobody named a pivot.
        acc = mathutils.Vector((0, 0, 0))
        for v in verts:
            acc += mw @ v.co
        centre = acc / len(verts)

    rot = None
    if "rotate_deg" in o:
        axis = mathutils.Vector(_vec(o.get("axis"), (0.0, 0.0, 1.0))).normalized()
        rot = mathutils.Matrix.Rotation(math.radians(float(o["rotate_deg"])), 3, axis)

    sc = o.get("scale")
    if sc is not None:
        sc = mathutils.Vector(_vec(sc) if isinstance(sc, (list, tuple))
                              else (float(sc),) * 3)

    for v in verts:
        w = mw @ v.co
        if sc is not None:
            w = centre + mathutils.Vector(
                ((w.x - centre.x) * sc.x, (w.y - centre.y) * sc.y, (w.z - centre.z) * sc.z))
        if rot is not None:
            w = centre + (rot @ (w - centre))
        w = w + offset
        v.co = inv @ w

    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.select] or bm.faces)
    n = len(verts)
    _close(bm, ob)
    what = []
    if offset.length > 1e-9:
        what.append(f"moved {[round(c, 4) for c in offset]}")
    if sc is not None:
        what.append(f"scaled {[round(c, 3) for c in sc]}")
    if rot is not None:
        what.append(f"rotated {o['rotate_deg']}deg")
    return f"{ob.name}: {n} vert(s) " + (", ".join(what) or "unchanged")


def op_sweep(o):
    """Run a profile along a path. Pipes, trim, rails, handles, cables.

    Uses parallel transport to carry the profile's orientation from one path
    point to the next, rather than rebuilding a frame from a fixed world "up"
    at each step. The naive version spins the profile wherever the path turns
    towards vertical, which puts a visible twist in every pipe that goes over a
    corner -- and a swept part with a twist in it is scrap.
    """
    prof = [tuple(float(c) for c in v) for v in o["profile"]]
    path = [mathutils.Vector(_vec(p)) for p in o["path"]]
    if len(prof) < 2:
        raise ValueError("a profile needs at least two points, as [u, v] pairs or [x, y, z]")
    if len(path) < 2:
        raise ValueError("a path needs at least two points")
    prof2 = [(p[0], p[1]) for p in prof]
    closed_profile = (prof2[0] == prof2[-1]) or bool(o.get("closed", True))
    if prof2[0] == prof2[-1]:
        prof2 = prof2[:-1]

    # A frame carried along the path, turned only by what the path does.
    tangents = []
    for i in range(len(path)):
        if i == 0:
            t = path[1] - path[0]
        elif i == len(path) - 1:
            t = path[-1] - path[-2]
        else:
            t = path[i + 1] - path[i - 1]
        if t.length < 1e-9:
            raise ValueError(f"path point {i} repeats the one before it")
        tangents.append(t.normalized())

    up = mathutils.Vector(_vec(o.get("up"), (0.0, 0.0, 1.0)))
    n0 = (up - tangents[0] * up.dot(tangents[0]))
    if n0.length < 1e-6:                       # path starts parallel to up
        n0 = tangents[0].orthogonal()
    n0.normalize()

    frames, normal = [], n0
    for i, t in enumerate(tangents):
        if i > 0:
            prev = tangents[i - 1]
            axis = prev.cross(t)
            if axis.length > 1e-9:
                ang = prev.angle(t)
                normal = mathutils.Matrix.Rotation(ang, 3, axis.normalized()) @ normal
            normal = (normal - t * normal.dot(t)).normalized()
        frames.append((normal.copy(), t.cross(normal).normalized()))

    ring = len(prof2)
    verts, faces = [], []
    for i, c in enumerate(path):
        nx, ny = frames[i]
        scale = float(o.get("scale", 1.0))
        for u, v in prof2:
            verts.append(tuple(c + nx * (u * scale) + ny * (v * scale)))
    for i in range(len(path) - 1):
        a, b = i * ring, (i + 1) * ring
        last = ring if closed_profile else ring - 1
        for k in range(last):
            k2 = (k + 1) % ring
            faces.append((a + k, a + k2, b + k2, b + k))
    if closed_profile and o.get("caps", True):
        faces.append(tuple(range(ring - 1, -1, -1)))
        faces.append(tuple(range(len(verts) - ring, len(verts))))

    res = op_mesh({"name": o.get("name", "Swept"), "verts": verts, "faces": faces})
    op_normals({"name": o.get("name", "Swept")})
    return f"{res} along {len(path)} path point(s)"


def op_bisect(o):
    """Cut the mesh with a plane -- a panel line, a shutline, or a trim.

    This is the knife. It puts a real edge loop where the plane crosses the
    surface, which is what a shutline IS: without one there is nothing to
    crease, inset or separate along, and panel lines have to be faked by
    booleans that leave ngons everywhere.
    """
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    mw = ob.matrix_world
    inv = mw.inverted_safe()
    co = inv @ mathutils.Vector(_vec(o.get("at")))
    no = (inv.to_3x3().transposed() @ mathutils.Vector(_vec(o.get("normal"), (0.0, 0.0, 1.0))))
    if no.length < 1e-9:
        bm.free()
        raise ValueError("the cutting plane needs a normal that is not zero")
    no.normalize()

    clear = str(o.get("clear", "none")).lower()
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(
        bm, geom=geom, plane_co=co, plane_no=no,
        clear_inner=(clear == "negative"), clear_outer=(clear == "positive"),
        use_snap_center=False)

    cut = [e for e in res.get("geom_cut", []) if isinstance(e, bmesh.types.BMEdge)]
    if o.get("fill") and cut:
        try:
            bmesh.ops.edgeloop_fill(bm, edges=cut)
        except RuntimeError:
            pass
    # Leave the new loop selected: the next op is almost always about it.
    for e in bm.edges:
        e.select = False
    for f in bm.faces:
        f.select = False
    for v in bm.verts:
        v.select = False
    for e in cut:
        if e.is_valid:
            e.select = True
            e.verts[0].select = True
            e.verts[1].select = True
    n = len(cut)
    _close(bm, ob)
    if not n:
        raise ValueError(
            f"the plane does not cross {ob.name} -- nothing was cut. Check `at` lies "
            "inside the object; measure its bounds if you are unsure.")
    return f"{ob.name}: cut a loop of {n} edge(s)" + (", filled" if o.get("fill") else "")


def op_snap(o):
    """Put the selection exactly somewhere: on a grid, on a plane, or on a surface.

    Near-enough is not enough. Vertices that are 0.3 mm apart look joined,
    measure as joined at a glance, and then fail to merge, leave a seam a
    boolean chokes on, and export as a hole.
    """
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    verts = _require(_sel_verts(bm), "snap", o)
    mw = ob.matrix_world
    inv = mw.inverted_safe()
    mode = str(o.get("to", "grid")).lower()
    moved = 0.0

    if mode == "grid":
        step = float(o.get("step", 0.01))
        if step <= 0:
            bm.free()
            raise ValueError("grid step must be positive")
        for v in verts:
            w = mw @ v.co
            t = mathutils.Vector([round(c / step) * step for c in w])
            moved = max(moved, (t - w).length)
            v.co = inv @ t
    elif mode == "plane":
        co = mathutils.Vector(_vec(o.get("at")))
        no = mathutils.Vector(_vec(o.get("normal"), (0.0, 0.0, 1.0)))
        if no.length < 1e-9:
            bm.free()
            raise ValueError("the plane needs a normal that is not zero")
        no.normalize()
        for v in verts:
            w = mw @ v.co
            t = w - no * (w - co).dot(no)
            moved = max(moved, (t - w).length)
            v.co = inv @ t
    elif mode == "surface":
        target = _obj(o["target"])
        dg = bpy.context.evaluated_depsgraph_get()
        tree = _bvh(target, dg)
        for v in verts:
            w = mw @ v.co
            loc = tree.find_nearest(w)[0]
            if loc is None:
                continue
            moved = max(moved, (loc - w).length)
            v.co = inv @ (loc + mathutils.Vector(_vec(o.get("offset"))))
    else:
        bm.free()
        raise ValueError(f"unknown snap target {mode!r}; try grid, plane or surface")

    _close(bm, ob)
    return f"{ob.name}: snapped {len(verts)} vert(s) to {mode}, furthest moved {moved:.5f} m"


def _viewport_area():
    """The 3D view of a window that is actually on screen, and that window."""
    wm = getattr(bpy.context, "window_manager", None)
    for win in (wm.windows if wm else []):
        scr = getattr(win, "screen", None)
        if not scr:
            continue
        for a in scr.areas:
            if a.type == "VIEW_3D":
                return win, a
    return None, None


def op_viewport(o):
    """What the 3D view is actually showing, right now.

    Not a render: the viewport, with its shading mode, its wireframes and its
    current angle -- the picture a person sitting in front of Blender is
    looking at. Rendering answers "what will this look like"; this answers
    "what am I working on", and they are different questions. Fast, too, which
    is what makes act-then-look affordable.
    """
    # The area must belong to the WINDOW being overridden. Searching
    # bpy.data.screens finds areas from screens no window is currently showing,
    # and the override then fails with "Area not found in screen".
    win, area = _viewport_area()
    if area is None:
        raise ValueError(
            "no 3D viewport in this session -- viewport capture needs a Blender with a "
            "window. In a headless batch, use look instead.")
    out = os.path.expanduser(str(o.get("to") or
                                 os.path.join(tempfile.gettempdir(), "omatron-viewport.png")))
    space = area.spaces[0]
    r = bpy.context.scene.render
    keep = (r.filepath, r.resolution_x, r.resolution_y, space.shading.type)
    if o.get("shading"):
        space.shading.type = str(o["shading"]).upper()   # WIREFRAME SOLID MATERIAL RENDERED
    try:
        res = max(240, min(int(o.get("resolution", 720)), 1600))
        r.filepath = out
        r.resolution_x, r.resolution_y = res, int(res * 0.7)
        region = next(rg for rg in area.regions if rg.type == "WINDOW")
        with bpy.context.temp_override(window=win, area=area, region=region):
            bpy.ops.render.opengl(write_still=True, view_context=True)
    finally:
        (r.filepath, r.resolution_x, r.resolution_y, space.shading.type) = keep
    return out


def op_view_angle(o):
    """Point the viewport somewhere. How you look around a model.

    A person orbits to check a form from another side; this is that, as an
    operation. Without it the session can only ever see the model from wherever
    the window happened to be left.
    """
    _, area = _viewport_area()
    if area is None:
        raise ValueError("no 3D viewport in this session")
    r3d = area.spaces[0].region_3d
    named = {
        "front": (math.radians(90), 0, 0), "back": (math.radians(90), 0, math.pi),
        "right": (math.radians(90), 0, math.radians(90)),
        "left": (math.radians(90), 0, math.radians(-90)),
        "top": (0, 0, 0), "bottom": (math.pi, 0, 0),
        "iso": (math.radians(60), 0, math.radians(-45)),
    }
    key = str(o.get("view", "iso")).lower()
    if key not in named and "rotation_deg" not in o:
        raise ValueError(f"view is one of {', '.join(sorted(named))}, or give rotation_deg")
    eul = mathutils.Euler(tuple(math.radians(a) for a in _vec(o["rotation_deg"]))
                          if "rotation_deg" in o else named[key], "XYZ")
    r3d.view_rotation = eul.to_quaternion()
    r3d.view_perspective = "ORTHO" if o.get("ortho") else "PERSP"

    if o.get("frame", True):
        dg = bpy.context.evaluated_depsgraph_get()
        lo, hi = None, None
        for ob in bpy.data.objects:
            if not _subject(ob):
                continue
            a, b = _bounds(ob, dg)
            lo = a if lo is None else [min(lo[i], a[i]) for i in range(3)]
            hi = b if hi is None else [max(hi[i], b[i]) for i in range(3)]
        if lo:
            r3d.view_location = [(lo[i] + hi[i]) / 2 for i in range(3)]
            r3d.view_distance = max(hi[i] - lo[i] for i in range(3)) * 2.0
    return f"looking {key}"


def op_subdivide_mesh(o):
    """Cut every edge (or the selected ones) -- real geometry, not a modifier.

    The subdivision MODIFIER smooths: it makes a coarse cage look soft without
    giving you anything to grab. This adds actual vertices in actual places, so
    the next thing you do can move them. Coarse cage, subdivide, fit, subdivide,
    fit -- that is how a form is refined from blueprints, and none of it
    involves smoothing anything.
    """
    import bmesh
    ob = _obj(o["name"])
    bm = _open(ob)
    sel = ([e for e in bm.edges if e.select]
           if o.get("only_selected") else bm.edges[:])
    if not sel:
        bm.free()
        raise ValueError(f"nothing selected on {ob.name} to subdivide")

    # A budget, checked BEFORE the operation runs.
    #
    # Subdivision with grid fill multiplies face count by (cuts+1)^2, so it
    # compounds: three rounds on a cube reached 3.5 million vertices, took the
    # machine into swap and wrote a 140 MB .blend. Nothing warned, because
    # nothing was watching -- the operation is perfectly happy to do what it
    # was asked. Predict the result and refuse, rather than discover it.
    budget = max(1000, min(int(o.get("budget", 200_000)), 2_000_000))
    cuts = max(1, min(int(o.get("cuts", 1)), 8))
    predicted = len(bm.faces) * (cuts + 1) ** 2
    if predicted > budget:
        have, faces = len(bm.verts), len(bm.faces)
        bm.free()
        raise ValueError(
            f"{cuts} cut(s) on {faces} face(s) would make about {predicted:,} faces, over the "
            f"{budget:,} budget ({ob.name} currently has {have:,} verts). Subdivision "
            f"multiplies by (cuts+1)^2 and compounds every time it is run, so this is how a "
            f"model reaches millions of vertices in three steps. Use fewer cuts, subdivide "
            f"only the part that needs resolution, or raise budget deliberately.")

    before = len(bm.verts)
    bmesh.ops.subdivide_edges(bm, edges=sel, cuts=max(1, min(int(o.get("cuts", 1)), 8)),
                              use_grid_fill=True, smooth=float(o.get("smooth", 0.0)))
    after = len(bm.verts)
    _close(bm, ob)
    return f"{ob.name}: {before} -> {after} verts"


def op_fit(o):
    """Push the mesh onto the shape the reference drawings describe.

    Not a loft -- a FIT. Take whatever geometry is there, and for each vertex
    look up how tall and how wide the car is at that point along its length,
    then move the vertex to sit at the same relative position inside those
    real bounds. A box becomes a car-shaped block; subdivide and fit again and
    it picks up the curve of the roofline and the taper of the plan.

    This is what working to a blueprint actually is, and it needs no modifier
    and no smoothing: the vertices go where the drawings say, and the shape is
    whatever those points describe.
    """
    ob = _obj(o["name"])
    n = max(8, min(int(o.get("samples", 96)), 400))
    side = _trace_view("side", n, o.get("floor", "sill"))
    try:
        top = _trace_view("top", n)
    except ValueError:
        top = None
    if not any(side["slices"]):
        raise ValueError("the side drawing traced to nothing")

    x_lo, x_hi = side["span"]
    bm = _open(ob)
    # Everything, unless the caller ASKS for the selection.
    #
    # "selected, or all if nothing is selected" reads as helpful and is a trap:
    # a primitive arrives with its own vertices selected, so after adding a cube
    # and subdividing it to 98 vertices, a fit silently moved the 8 original
    # corners and left the rest where they were. It reported success. Requiring
    # only_selected makes the narrow case deliberate.
    verts = ([v for v in bm.verts if v.select]
             if o.get("only_selected") else bm.verts[:])
    if not verts:
        bm.free()
        raise ValueError(f"nothing selected on {ob.name} to fit")
    mw, inv = ob.matrix_world, ob.matrix_world.inverted_safe()

    world = [mw @ v.co for v in verts]
    xs = [w.x for w in world]
    zs = [w.z for w in world]
    ys = [abs(w.y) for w in world]
    x0m, x1m = min(xs), max(xs)
    z0, z1 = min(zs), max(zs)
    ymax = max(ys) or 1.0
    zspan = (z1 - z0) or 1.0
    xspan = (x1m - x0m) or 1.0

    def sample(track, t):
        """The drawing's extent a fraction t along the car, interpolated."""
        f = max(0.0, min(t, 1.0)) * (len(track) - 1)
        i = int(f)
        a = track[min(i, len(track) - 1)]
        b = track[min(i + 1, len(track) - 1)]
        if a is None or b is None:
            return a or b
        k = f - i
        return (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k)

    missed = 0
    for v, w in zip(verts, world):
        # Along the car by the vertex's own position in the mesh, not its world
        # x -- a 2 m cube fitted to a 4 m car has to STRETCH, and reading world
        # x against the drawing's span left it 2 m long with the right cross
        # section, which looked like the fit had simply not run.
        t = (w.x - x0m) / xspan
        x = x_lo + (x_hi - x_lo) * t
        sv = sample(side["slices"], t)
        if sv is None:
            missed += 1
            continue
        zb, zt = sv
        # Where this vertex sits between the mesh's own floor and roof, kept.
        f = (w.z - z0) / zspan
        z = zb + (zt - zb) * f

        y = w.y
        if top is not None:
            tv = sample(top["slices"], t)
            if tv is not None:
                half = max(abs(tv[0]), abs(tv[1]))
                y = (w.y / ymax) * half

        v.co = inv @ mathutils.Vector((x, y, z))

    _close(bm, ob)
    src = "side+top" if top is not None else "side only"
    return (f"{ob.name}: fitted {len(verts) - missed} vert(s) to {src}"
            + (f", {missed} outside the drawing" if missed else ""))


OPS = {
    "add": op_add,
    "mesh": op_mesh,
    "shade": op_shade,
    "normals": op_normals,
    "studio": op_studio,
    "look": op_look,
    "viewport": op_viewport,
    "view_angle": op_view_angle,
    "reference": op_reference,
    "trace": op_trace,
    "loft": op_loft,
    "render_view": op_render_view,
    "select": op_select,
    "select_loop": op_select_loop,
    "revolve": op_revolve,
    "bridge": op_bridge,
    "separate": op_separate,
    "clean": op_clean,
    "move": op_move,
    "sweep": op_sweep,
    "bisect": op_bisect,
    "snap": op_snap,
    "smooth": op_smooth,
    "crease": op_crease,
    "inset": op_inset,
    "extrude": op_extrude,
    "bevel_edges": op_bevel_edges,
    "loop_cut": op_loop_cut,
    "subdivide": op_subdivide_mesh,
    "fit": op_fit,
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
    "apply_transform": op_transform_check,
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


def _subject(ob):
    """Is this object part of the MODEL, or scenery we added around it?

    A studio floor is a mesh like any other, so it framed the camera, stretched
    the scene bounds and joined the silhouette -- an 86-metre plane next to a
    4-metre car put the car three pixels wide. Anything this file adds for
    presentation is tagged, and every measurement and framing skips it.
    """
    return ob.type == "MESH" and not ob.hide_render and not ob.get("omatron_helper")


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
    meshes = [o for o in bpy.data.objects if _subject(o)]
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


# Guarded so this file can be IMPORTED as well as run.
#
# The live session runs inside a GUI Blender and executes the same table this
# script does -- that sameness is the point, because it means the interactive
# path opens no execution surface the batch path did not already have. An
# unguarded main() made importing it impossible.
if __name__ == "__main__":
    main()
