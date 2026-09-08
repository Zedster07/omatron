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

## Anything turned is a revolve

A rim, a flange, a bottle, a pulley, a vase — every one is a 2D profile spun
about an axis, and stacking cylinders to fake one never works. Draw the
cross-section, spin it:

    {op:"revolve", name:"Tyre", axis:[0,1,0], steps:48,
     profile:[[0,-0.105,0.20],[0,-0.105,0.295],[0,-0.088,0.315],
              [0,0.088,0.315],[0,0.105,0.295],[0,0.105,0.20],[0,-0.105,0.20]]}

Repeat the first point at the end to close the section. A revolved profile
comes out all quads with no non-manifold edges — the cleanest geometry this
tool produces.

## Work in loops, not boxes

`select` by region and normal is a spatial query. Real modelling is loops: pick
an edge, run the loop round the form, operate on that. Every panel line,
support loop and bridge is a loop operation and none is expressible as a
bounding box.

    {op:"select_loop", name:"Tyre", near:[0.315, 0.088, 0.021]}
    {op:"bevel_edges", name:"Tyre", width:0.010, segments:2}

**Bevel a loop, never a ring.** A loop is a continuous chain along the surface;
a ring is the parallel edges crossing a band. Bevelling the loop round a tyre
gave 384 quads and no ngons; bevelling the ring at the same place gave 192
triangles and 96 ngons and halved the quad ratio. The topology assert catches
it either way — but knowing which you have saves the cycle.

`near` names an edge by a point in space, because an index means nothing to
anyone who did not place the vertex and changes the moment anything is bevelled.

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

## The rules of subdivision

Subdivision is not a smoothing button. It has rules, and breaking them produces
a specific ugly result rather than an error, which is why it is so easy to use
it wrongly for a long time.

**It softens every edge, without exception.** Two things stop that, and you must
use one of them deliberately:

- **Support loops** (also called holding edges): extra loops running parallel
  to an edge, close to it. The closer the loop, the tighter and sharper the
  edge. This is the production method — it lives in the geometry, so it
  survives export and bakes correctly.
- **Creases**: a 0–1 weight on the edge. Cheap and non-destructive, but not
  every exporter and engine respects them, and at 1.0 they can look
  artificially perfect.

The practical way to add support loops is **a small bevel**: `bevel_edges` with
1–2 segments puts a loop on each side of the edge automatically. Bevel, then
subdivide.

**Order in the modifier stack is not cosmetic.** It is:

    Mirror -> Array -> Boolean -> Solidify -> Bevel -> Subdivision -> Weighted Normal

Bevel after Subdivision bevels the already-smoothed result instead of holding
its edges. Boolean after Subdivision cuts into dense geometry and leaves a mess.

**Subdivision demands quads.** Ngons pinch and crease unpredictably;
triangles pinch less but still pinch. Booleans emit ngons freely, so check
after every one — `{op:"assert", what:"topology", max_ngons:0}` — and clean up
before subdividing.

**Poles pinch on curved surfaces.** A vertex where three or five-plus edges
meet distorts the surface around it. Keep poles in flat regions, off the
panels you want smooth.

**Subdivision smooths a shape; it cannot invent one.** This is the rule that
matters most and the one that is easiest to miss, because the result looks
"soft" rather than "wrong".

## A cage dense enough to subdivide

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

## Work from a blueprint

Proportions guessed are proportions wrong, eventually. Attach reference
drawings and check against them:

    {op:"reference", view:"side",  image:"~/ref/hatch-side.png"}
    {op:"measure",   what:"silhouette", view:"side"}
    {op:"assert",    what:"silhouette", view:"side",
                     min_overlap:0.85, max_aspect_error:0.05}

`reference` attaches the drawing to a view and shows it in the viewport, so
whoever is watching sees what the model is being fitted to. `silhouette`
renders that orthographic view and compares outlines, returning two numbers:

- **overlap** — how much of the two outlines coincide. Trust this when the
  reference is a filled silhouette.
- **aspect_error** — how far the width-to-height ratio is from the drawing's.
  Trust this for a line-art blueprint, where overlap means little: an outline
  drawing has almost no filled area to overlap with a solid render.

Both are computed after normalising each outline to its own bounding box, so a
drawing scanned at any size compares correctly against a render at any
distance. It asks about shape, not scale.

**Give the reference a real size** — `length` or `height` in metres. The plate
is then placed with the drawing's ground line on z=0 and its centre on x=0,
which is where you are about to build, so model and drawing overlap in the
viewport and the overlap means something. A plate with no scale is decoration.

**Read the overlay, not just the number.** `silhouette` writes one: grey where
model and drawing agree, red where the drawing has body the model does not
reach, blue where the model overhangs the drawing. It found in one glance
something no number had caught — a model built mirrored, cabin left against the
drawing's cabin right. A mirrored car has an identical bounding box, so the
aspect-ratio check scored it a perfect fit.

**Three views, not one.** A side blueprint pins the profile and says nothing
about width — which is most of what you see from any angle that is not directly
side-on.

    {op:"reference", view:"side",  image:"...", length:3.962}
    {op:"reference", view:"top",   image:"...", length:3.962}
    {op:"reference", view:"front", image:"...", width:1.727}
    {op:"loft", name:"Body", stations:30, ring:18, section_from:0.30}

Side gives the profile, top gives width along the length, and **front gives the
cross-section shape** — the only one of the three that describes the section
rather than an extent, and the one that stops every station being the same
invented oval. Check the reported mm/px across views: if they disagree, the
drawings are not to a common scale and nothing built from them will be either.

Two settings earn their keep. `floor:"sill"` stops the side profile following
the *tyres* down to the road at each axle — the sill is the highest the lower
edge reaches between the wheels, and no part of the body sits below it.
`section_from` trims the bottom of the front view, which is running gear, not
bodywork; without it the body is as wide as the track at ground level.

**And know what three views cannot give you.** The intersection of three
extrusions is fatter than the real object, and no orthographic outline records
a crease. Worse, one front view supplies one section shape, scaled to every
station — but a real body changes section along its length, and nothing in
three silhouettes says how. A Shelby Cobra traced this way fits its side
profile well and still renders as a lump, because a roadster with flared arches
and an open cockpit is close to the worst case: its outlines enclose far more
than its body. Expect a good blockout, not a finished surface.

**Trace the drawing; do not eyeball it.** A blueprint holds the profile
already — read the outline column by column and let it give you the station
heights. Fitted that way an Alfa 147 reached 73% silhouette overlap
with the drawing, overhanging it nowhere.

And check the silhouette on the **whole** model, not part of it. A blockout
with no wheels measured 16% out against a drawing whose outline runs down to
the tyre contact patch — the model was fine, the comparison was not yet the
same question.

One blueprint constrains one plane. A side view fixes the profile and says
nothing about width: the car built from this one has a correct roofline and an
invented plan view, and it shows. Get front or top views too when the shape
matters in those directions.

`render_view` gives you the orthographic side, front or top on its own.
Do that early: a silhouette shows proportion faults that a three-quarter
render hides completely.

## Look while you work, not only at the end

A batch used to be blind: apply forty operations, render once, and discover the
nose was mangled with no idea which operation did it. That is feedback about
the result, not about the process — it costs the whole build and tells you
nothing about where it went wrong.

`{op:"look", label:"..."}` renders the model as it stands, mid-batch, and
returns the picture **with the numbers that go with it** — object list, face
counts, sizes, and every measurement taken since the previous look. Several in
one batch and you watch the form arrive step by step.

Look at the points where a decision was made:

    {op:"look", label:"blockout — proportions only"}
    ... arches, glazing ...
    {op:"look", label:"after the boolean", view:"side"}

Especially **before anything irreversible** — a boolean, an apply_modifiers, a
subdivision. Those are the operations that destroy the thing you would want to
go back to.

When a later operation fails, the looks taken before it still come back. That
is the difference between "the nose is mangled" and "the nose was fine until
the second inset" — the failure arrives with the evidence.

Use both halves. The picture shows what a number cannot: that a form reads as
a car, that a surface is lumpy, that a panel gap looks wrong. The numbers show
what a picture cannot: that a part is buried, that two parts interpenetrate,
that a wheel floats. Neither alone is enough, which is why a look returns both.

Eight looks per batch is the limit, and hitting it means the batch is doing too
much at once. Split it and look between the calls.

## Shading is not the last 10%

Most of whether a render reads as convincing is shading and light, not
geometry. The same body, unchanged, goes from grey lump to something that
looks like a product on finishes and a studio rig alone — proved on one mesh
in one session, twice.

    {op:"material", name:"Body",  finish:"paint", color:[0.35,0.04,0.06]}
    {op:"material", name:"Wheel", finish:"rubber"}
    {op:"material", name:"Glass", finish:"tinted_glass"}
    {op:"studio"}

Reach for a named finish — paint, rubber, glass, chrome, alloy, brushed,
plastic, lens, steel — rather than guessing at four sliders. `color` and the
rest still override where you want them to. `studio` scales its lights to the
subject, because a rig sized for a ring blows out a car and one sized for a car
underlights a ring.

## Apply scale and rotation. No exceptions

An object carrying scale (1.6, 1.0, 0.3) renders fine and then betrays you:
normals shear, bevel widths come out different on each axis, and every exporter
bakes something different. `{op:"apply_transform", name:"..."}` bakes it in;
`{op:"assert", what:"transform", name:"...", uniform_scale:true, applied:true}`
refuses to continue without it.

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
