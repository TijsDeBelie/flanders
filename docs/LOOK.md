# The look: towards a painted, toy-village style

The target is the soft, saturated, hand-painted look of a stylised village builder: chunky shapes, every stone and roof tile drawn as its own piece, warm light
with soft shade where things meet. Everything in Flanders is still made in code (no image files), so the work is in how materials are painted and lit.

Rule for every phase: **building tiers must stay as distinct as they are.** Tiers pick different materials (wood → half-timber → stone walls, thatch → tile → slate
roofs) and add geometry; the phases repaint those materials and soften shapes, but never change which material a tier uses. The village roof palettes
(`ROOFS` in `src/flag.ts`) tint the tile texture, so it must keep its terracotta average colour.

## Checking a change

`web/tools/lookshots.mjs` takes the same screenshots every time: the village from three angles, five rows of the building test hall (tiers left to right) and six
close-ups. Run it against two dev servers (the old code and the new) and compare.

```
cd web && npx vite --port 5173          # (npm run wasm first if the wasm is not built)
node tools/lookshots.mjs /tmp/shots-after http://localhost:5173/
node tools/lookshots.mjs /tmp/shots-nofx http://localhost:5173/ --fx=off
```

## Done

**Phase 1: colour and light.**
- `src/render/look.ts`: the colour grade, inside the tone mapping step every material already runs (no extra pass). The neutral tone curve (Khronos PBR Neutral)
  replaces ACES, which greyed every colour. Mid-tones get a little more saturation, pale surfaces ease back towards white (the materials were painted for ACES;
  without this, plaster went cream), highlights lean warm and shadows slightly cool. `GRADE` holds the numbers; `tests/look.test.mjs` checks them.
- `src/render/sky.ts`: exposure for the new curve (`EXPOSURE`), whiter sunlight.
- `src/render/post.ts`: optional image effects, reusing the scene pass's depth (no second drawing of the scene). *Soft contact shadows* (ambient occlusion at
  half resolution) and *Glow* (bloom on light far past white: lit windows, fires, sun on snow). Both are under Settings → Display → Image. On at High and Ultra,
  off at Low and Medium, so phones, tablets and integrated graphics keep today's cost. With both off, the scene is drawn straight to the screen as before.

**Phase 2: hand-painted building textures.** `src/render/painted.ts` paints the stone, dark stone, brick, Flemish brick, cobble, wood, dark wood, thatch, tile,
slate, plaster, daub and half-timber textures piece by piece at 512 px. Each piece has a lit upper edge, a shaded lower edge, a dark gap and its own hue drift.
A height picture drawn from the same shapes makes the normal map, so the bump follows the real pieces. The textures are seeded (the same on every load) and keep
the old layouts and average colours. Painting all of them takes about 0.7 s in a headless browser that draws on the CPU, less on a real graphics card.

**Phase 3: softer shapes.** `src/render/chamfer.ts`: a box with bevelled edges (the same 24 vertices as a plain box, 44 triangles instead of 12; the light blends
across the bevel, which reads as a rounded edge). `b.box` in `buildings.ts` uses it for every box big enough to show one (`bevelFor`: walls get up to 0.24 units,
beams a slight edge); small trim (quoins, joists, shutters, rafter tails) stays a plain box. Roof eaves are thicker (0.24, thatch 0.42) and the ridge beam is
bevelled. Across all building models this adds about 37% triangles (houses 54%); draw calls are unchanged, and distant houses still give way to the 18-triangle
proxies. `tests/chamfer.test.mjs` checks the shape is closed, wound outwards, the right size and textured like a plain box.

**Phase 4: ground, roads and fields.**
- Grass (`patchGround` in `src/render/groundtex.ts`): broad swathes of warmer and cooler green at every distance; close up, clumps with lit tops and shaded
  hollows, and now and then a small white, yellow or pink flower.
- Roads (`src/render/paths.ts`): a bump from the surface's own brightness, so cobbles, flagstones and gravel catch the sun close up. The textures themselves
  were already painted stone by stone and are pinned down by `tests/roadlook.test.mjs`, so they are unchanged.
- Fields (`painted.ts`, `farm` in `buildings.ts`): painted crops in place of flat colour: young shoots on the first field, ripe wheat, leafy greens and ploughed
  furrows on the fields a bigger farm adds. Painting the four adds about 0.25 s at load (CPU-drawn headless browser).
- Still plain: garden lawns and pastures inside building models (the palace garden, parks) are flat-colour materials. Giving them the terrain's grass shader
  (`patchGround`) is the next small step.

**Phase 5: snow on the village in winter.** `src/render/snow.ts`: one shader patch, added after any patch a material already has, whitens what faces up
(roofs up to about 55 degrees, the ground, tops of walls, beams, hay, fields, tree crowns) with a ragged, noisy edge; walls and steep faces stay bare, and the
baked shade of eaves and corners shows through. One shared uniform says how much (`snowCover(tick)`): it settles over the first day and a half of winter and
melts over the last two days and the first day of spring. Added to every opaque, non-glowing building material (in `B.add` and the shared set), the terrain and
the near tree crowns. Clones of a snowy material (colour variants, roof palettes, merged batches) keep the patch (`keepSnow`). `tests/snow.test.mjs` checks the
timing; `node tools/lookshots.mjs <dir> --winter` shoots full snow (`__game.setSnow`). Not snowy yet: fences and walls drawn by the Walls mesh, distant tree
crowns (lit per vertex), and the building test hall's platform.

**Phase 6: villagers.** In `src/render/crowd.ts`: a head 1.38 times bigger (raised a little off the collar), hats and helmets grown to fit, a torso 12%
rounder, and the same for the distant two-part figures. Only the part shapes changed: joints, gait, poses and the hats, tools and shields hung on them are as
before (`HEAD_SCALE`, `HEAD_LIFT`, `TORSO_ROUND`).

## Next

**Phase 7: new items from the concept sheets.** A three-tier weigh house (wooden scale frame → covered stone yard → stone merchant's house with copper roofs),
peddler carts with a mule, signposts and goods piles. They need two more painters in `painted.ts`: copper verdigris (teal, standing seams, pale streaks) and
striped canvas. The copper roof is a good top-tier marker elsewhere too.

**Later, optional:** a miniature-style blur at the screen edges (a tilt-shift pass in `post.ts`, off by default), and window glow tuned with the bloom at night.
