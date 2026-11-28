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

## Next

**Phase 3: softer shapes.** The biggest step towards the toy look, and the riskiest for draw cost and tier recognition.
- Bevel the shared box and cylinder helpers in `src/render/buildings.ts` (`b.box`, `b.cyl`, `b.gable`), not the 2,500 lines of individual models: chamfered edges
  with a light vertex-colour highlight along them. One change softens every building.
- Thicker roof overhangs and fascia boards on `b.gable`; slightly rounder chimneys.
- Check: triangle counts in `tests/models.test.mjs`, the batched far-house path (`farHouseMat`) and the draw-call folding (`foldedMaterial`) still apply.
- Check every tier in the test hall side by side (lookshots `hall-*`).

**Phase 4: ground and roads.** Most of the screen is ground, and it still reads flat.
- `src/render/groundtex.ts` `patchGround`: painted grass clumps with hue drift (warm-dry and cool-damp patches), a few flower dots near the camera.
- Roads (`src/render/roadlook.ts`, `src/render/roadmesh.ts`): the painted cobble from Phase 2, a soft pebble edge into the grass.
- The plain-coloured field, crop and garden materials in `buildings.ts` (`field`, `soil`, `leaf`, `straw` and the inline `MeshStandardMaterial` colours) were
  tuned under ACES. Under the new curve the crop greens and wheat yellows read a little loud, so give them the same painted treatment and calmer bases.

**Phase 5: snow on the village in winter.** The core already reports the season (`src/winter.ts`). One shader patch on the shared materials whitens surfaces that
face up (roofs, ground, tree tops, log piles) with a soft, noisy edge, faded in at the start of winter and out at the end. The roof textures' height picture can
make snow sit in the courses. Cheap: no new geometry.

**Phase 6: villagers.** Bigger heads, rounder bodies and bigger hats, in `src/render/crowd.ts` and `src/render/people.ts`. They are instanced, so proportions
cost nothing to draw. Keep job-readable silhouettes (hats and tools in `LOOKS`).

**Phase 7: new items from the concept sheets.** A three-tier weigh house (wooden scale frame → covered stone yard → stone merchant's house with copper roofs),
peddler carts with a mule, signposts and goods piles. They need two more painters in `painted.ts`: copper verdigris (teal, standing seams, pale streaks) and
striped canvas. The copper roof is a good top-tier marker elsewhere too.

**Later, optional:** a miniature-style blur at the screen edges (a tilt-shift pass in `post.ts`, off by default), and window glow tuned with the bloom at night.
