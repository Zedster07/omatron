---
name: blender-modelling
description: How to model well with Omatron's Blender tools — build order, symmetry, bevels, shading and topology. Use whenever asked to model, sculpt, build or edit a 3D object.
---

# Modelling, not assembling

The failure this exists to prevent, in the words of the person who saw it:

> "you just use same shapes like squares and cylinders to form a cube car,
> there is no modeling involved there"

That is what happens when you reach for `add` five times and call the result a
car. A form assembled from whole primitives reads as whole primitives, however
carefully they are positioned. What follows is the difference.

## Build order: big, then medium, then small

Establish the silhouette first, at low resolution, and do not touch details
until the overall proportions are right. Detail added early has to be redone
when the proportions change, so it gets kept instead — and the proportions stay
wrong. Blockout, then refine.

## One mesh beats five primitives

`add` gives you a primitive. `mesh` takes vertices and faces, which is where
actual form comes from — a car profile is a dozen well-placed points, not a box
with another box on top. If the shape has a silhouette worth having, define the
silhouette.

`extrude_profile` turns a 2D outline into a solid, which is most hard-surface
work: draw the cross-section, give it depth.

## Symmetry is structural

Use `{op: "modifier", kind: "mirror", axis: "x"}` and model one side. Placing
both halves by hand is two chances to typo a coordinate and no guarantee they
match. Mirror here reflects about the **world origin**, so a part at x=1.36
gets its twin at x=-1.36 — model the right side of the car and the left side
follows for free, permanently, including every later edit.

## Bevel everything

Real objects have no perfectly sharp edges. A bevel one or two millimetres wide
catches a highlight along every edge, and that highlight is most of what makes
a render look like a manufactured object rather than a diagram. `{kind:
"bevel", width: 0.02, segments: 2}` on anything solid. Follow it with
`weighted_normal` so the bevel shades correctly instead of smearing.

## Shade with an angle

`{op: "shade", name: "Body", smooth: true, angle_deg: 30}` — faces meeting at
less than 30° blend into a curve, sharper joins stay crisp. A low-poly form
shaded flat reads as facets; the same mesh shaded by angle reads as a body.
This is the cheapest quality improvement available and it changes no geometry.

## Keep quads

Ngons shade unpredictably and subdivide badly. Booleans produce them freely —
cutting four wheel arches into a car body left 38. Check after every boolean:

    {op: "assert", what: "topology", name: "Body", max_ngons: 0, max_non_manifold: 0}

`min_quad_ratio` is the softer version when some ngons are tolerable.

## Measure. Do not squint at the render

A picture will not tell you that a part is buried inside another one, that two
parts pass through each other, or that a wheel floats above the ground. All
three look fine from a distance, and all three were in the first car.

    {op:"assert", what:"enclosed", name:"Glass",  with:"Body", enclosed:false}
    {op:"assert", what:"overlap",  name:"Wheel1", with:"Body", intersects:false}
    {op:"assert", what:"bounds",   name:"Wheel1", z_min:0, z_max:0}

A failed assert aborts the batch **before the save**, so the file is never left
in a state you have already been told is wrong. End every batch with the
assertions that say what must be true. They cost one line and they are the only
thing standing between you and confidently shipping a car whose windows are
inside the bodywork.

## What you are not

You are not sculpting. Organic and artistic forms — a face, a tree, drapery —
are not what a fixed op table does well. Say so plainly rather than
approximating them with primitives, which is how this started.
