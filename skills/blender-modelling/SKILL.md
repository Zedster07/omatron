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

## One surface first, panels later

The way vehicles are actually modelled: build the whole outer surface as a
single continuous piece, with the proportions right, and do not cut it into
panels until the form is finished. Body, roof, bonnet and wings are one skin;
the gaps between them are cut afterwards.

The first car did the reverse — a box for the body, a box for the cabin, a box
for the skirt — and that is precisely why it read as boxes. Separate objects
have no shared silhouette, so there is no continuous form for the eye to
follow, and no amount of positioning creates one.

Curved surfaces want **evenly spaced loops**; where the surface flattens out,
terminate them rather than carrying the density across the whole mesh. Favour
even quads and avoid long thin triangles.

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

## Feature lines: select, crease, subdivide

A car body is defined by its creases — a beltline, a shoulder, the edge of a
bonnet. Subdivision alone melts every one of them, which is how a lofted body
turns into a bar of soap.

    {op:"select", name:"Body", sharper_than:38, elements:"edges"}
    {op:"crease", name:"Body", weight:1.0}
    {op:"modifier", name:"Body", kind:"subdivide", levels:1}

Creases hold the edges that should stay sharp; subdivision smooths only the
panels between them.

Recesses — grilles, lamps, vents — are `inset` then `extrude` inward. The
inset leaves its inner faces selected, so the extrude needs no second select.

    {op:"select", name:"Body", normal:"+x", tol:46, region:[...], elements:"faces"}
    {op:"inset",   name:"Body", thickness:0.035}
    {op:"extrude", name:"Body", distance:-0.055}

Select by **position and direction**, never by index: an index means nothing if
you did not place the vertex, and it changes the moment anything is inset. When
a selection comes back empty the error names the filter that emptied it —
region or normal — so read it rather than guessing which to widen.

## Subdivision needs a cage dense enough to subdivide

The limit this hit, recorded so it is not hit again: a body lofted from 10
cross-sections of 5 points is 36 quads, and **36 quads is not enough geometry
to hold a shape through subdivision**, creased or not. It over-smooths into a
blob, and an inset on a surface that coarse crumples instead of ringing
cleanly — the grille came out chewed rather than cut.

Before reaching for subdivision or recesses, give the cage the resolution the
form needs: more stations along the length, more points per section, and
`loop_cut` for support loops beside the edges that must stay crisp. Resolution
first, then creases, then detail. Detail on a coarse cage is worse than no
detail, because it destroys the silhouette that was working.

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

## Build by hand, then fix the normals

A mesh from explicit vertices has whatever winding you happened to write, and a
face wound the wrong way shades as a hole. Follow every `mesh` with
`{op: "normals", name: "..."}`. There is no getting this right by being careful
about vertex order.

## What an assertion does and does not tell you

`enclosed` asks whether every vertex of one part lies inside another's volume —
a real containment test, not a bounding-box one, so a windscreen that sits
inside the car's overall box while protruding through the roof reads correctly
as visible.

But an assertion only checks what you asked. Headlamps that passed
`enclosed: false` were plainly visible and plainly in the wrong place, sitting
on the bonnet rather than the nose. Visible is not correct. Use `bounds` to
pin down where a part should actually be when position is what matters.

## What you are not

You are not sculpting. Organic and artistic forms — a face, a tree, drapery —
are not what a fixed op table does well. Say so plainly rather than
approximating them with primitives, which is how this started.
