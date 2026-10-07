# Prompt: Gib, the Celer mascot (style brief for another agent)

Copy everything below the line into the other agent. Attach the four reference SVGs in `docs/brand/mascot/`
(`gib-poker.svg`, `gib-laptop.svg`, `gib-monday.svg`, `gib-icon.svg`): they are the source of truth.

---

You are drawing **Gib**, the mascot of **Celer**, a fast desktop SQL client.
Gib must look exactly like the attached reference SVGs. Reproduce the style precisely; do not reinterpret it.

## Character

- A **cartoon monkey office worker**. Serious, a bit tired, deadpan, slightly scruffy. The humour comes from the
  contrast: a monkey that takes your database very seriously.
- He wears **only a white shirt and a black tie** (no jacket). The collar is white with a light grey edge.
- Big head, small body (head ≈ 60 % of the figure height). Bust only: we never draw legs.
- Expression by default: **"poker face"** — big eyes with **heavy half-closed upper eyelids**, one eyebrow raised,
  a short flat mouth. He looks like he has just seen your `SELECT *` and says nothing.
- Personality: calm, competent, dry humour. Never goofy, never angry, never cute-baby.

## Style rules

- **Vector, flat cartoon** with very soft shading: a radial gradient on the fur (lighter at top-left), a vertical
  gradient on the shirt (white to light grey). No outlines around shapes; strokes only for facial features
  (eyelid line, eyebrows, mouth, eye bags) and props (glasses, steam).
- Rounded geometry: circles and ellipses for head, ears and face; round line caps everywhere.
- Hair: **pointed, curved tufts** (leaf-shaped) sticking out of the top of the head. Neat version: 3 tufts.
  Messy version: 8 tufts in every direction, including the sides.
- Subtle pink **cheek blush** (`#F4A6A0` at 35 % opacity) except in the flat icon version.
- Works on dark (`#1F232A`) and light (`#F3F5F8`) backgrounds without changes.

## Palette (exact)

| Part | Colour |
|---|---|
| Fur base / gradient | `#6E4B33`, gradient `#8B6246` → `#56392A` |
| Face skin | `#F2D0AC` |
| Ear inside, eye bags | `#E2B38B` |
| Upper eyelids | `#E7BE96` |
| Feature lines (eyelid line, nostrils, mouth) | `#9A6A49` |
| Eyebrows | `#56392A` |
| Eye white / pupil / glint | `#FFFFFF` / `#24170F` / `#FFFFFF` |
| Shirt | `#F7F7F4` → `#DCDEE3`, collar edge `#DCDEE3` |
| Tie | `#16171B` |
| Tongue | `#EE7C8E` |
| Brand accent (mug band, laptop logo) | Ember `#F26B1D` |
| Laptop | `#2B2F36`, top edge `#3A404A` |
| Glasses | `#2A2B30` |

## Construction (viewBox `0 0 200 210`)

- **Body:** shirt path from (50,200) curving up to shoulders and neck at y≈154; fur neck ellipse at (100,150) rx 19 ry 8.
  Tie knot: trapezoid 10 wide at y 158–166.5; blade widening to ±10 at y≈197, pointed tip at y≈206.
  Collar: two white triangles from the neck point (100,157) out to (85,147)/(115,147) and down to (80,166)/(120,166).
- **Ears:** fur circles r 22 at (36,94) and (164,94), inner skin circles r 13.5 slightly toward the face.
- **Head:** fur ellipse centre (100,88), rx 64, ry 58. Tufts on top starting around y 32–36.
- **Face mask** (skin): union of two circles r 27 at (79,86) and (121,86) plus an ellipse (100,118) rx 37 ry 25.
- **Eyes:** white ellipses rx 15 ry 16 at (79,84) and (121,84). Pupils r 6.6, placed **low** in the eye (cy ≈ 89)
  with a small glint up-right. Upper eyelid = skin-coloured cap clipped to the eye, covering **50 %** of the eye
  height by default, with a slightly curved darker eyelid line at its lower edge.
- **Eyebrows:** thick (5 px) round strokes in dark fur colour above the eyes.
- **Nose:** two small nostril ovals at (94,111) and (106,111). No nose bridge.
- **Mouth:** short flat line around (94–114, 127), slightly off-centre to the right.

## Expression system

Change only these parameters; everything else stays identical:

| Parameter | Values |
|---|---|
| Eyelid closure | 0.42 focused · 0.50 poker face (default) · 0.64 tired |
| Eyebrows | *skeptic*: left flat, right raised · *focused*: both slanted down toward the nose · *tired*: both low and flat |
| Mouth | *flat* line · *meh* wavy line · *tongue*: flat line with the tongue tip out at the right corner |
| Pupils | Default low-centre; looking down at a screen: 4 px lower; distracted: 2 px left |
| Extras | Eye bags (tired), round reading glasses (working) |

## Reference poses

1. **Poker face** (`gib-poker.svg`) — main character: neat 3-tuft hair, straight tie, skeptic brows, flat mouth.
2. **At the laptop** (`gib-laptop.svg`) — round reading glasses, focused brows, eyes down, tongue out in concentration,
   both fur arms coming from the bottom corners, hands resting on a dark laptop with the Celer logo (orange C + three bars).
3. **Monday morning** (`gib-monday.svg`) — very messy hair (8 tufts), tie rotated ~11° and loosened, one collar point up,
   tired brows and eye bags, wavy mouth, eyes slightly to the left, holding a big white mug with an orange band and steam.
4. **Icon** (`gib-icon.svg`) — the poker face without gradients or blush, for 24–40 px (status bar, notifications).

## Do / don't

- Do keep the head big, the eyelids heavy and the tie black. Keep the white shirt with no jacket.
- Do keep every pose recognisable at 24 px: high contrast between dark fur, light face and white shirt.
- Don't add a jacket, a suit, colourful ties, teeth, open-mouth smiles, sparkly anime eyes or realistic fur.
- Don't use outlines around the body or head. Don't use drop shadows.
- Don't change the palette. The only brand colour on Gib is the Ember accent on props.

## Deliverables

- SVG, `viewBox="0 0 200 210"`, IDs prefixed per file, no external references, under 6 KB each.
- For animation later: keep head, eyelids, pupils, eyebrows, mouth, each hand/arm, tie and props as separate
  named groups so they can be animated independently (blink = eyelid closure to 1.0 for 120 ms).
