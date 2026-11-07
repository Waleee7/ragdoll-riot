# RAGDOLL RIOT: Locations + Infinite Mode

Owner's ask: "build the game, infinite mode, make sure it all adds in smooth and seamless, no issues, test it."
Vibe: the weight and drama of a dark tournament fighter, stickman chaos, a choice of living locations.
Original work only: no names, characters, symbols, or catchphrases from any existing game (no "Finish him", "Fatality", dragon marks).

## Constraints (existing project)
Plain HTML/CSS/JS ES modules, no build step, zero runtime deps. 60 fps with 12 ragdolls on a phone. Background is a cached
canvas (#bg) painted once per resize; do NOT re-blit a full-screen image every frame outside a short transition.
Match surrounding code style (dense, small comments). All existing checks (`npm test`) must keep passing without being weakened.

## Art
`art-src/*.jpg` (2752x1536, owner's art): ring-a/b/c, pit-a/b, margins-a/b. All 7 are used.
Add `scripts/build-art.mjs` (Playwright canvas is fine; no new runtime deps) producing `art/<id>.webp` about 1920 wide
(under ~450 KB each) and small thumbs for the picker. Commit outputs. `.vercelignore` must exclude art-src/ so the live site ships only art/.
Measure each image's floor line by looking at it (they differ: roughly ring-a .71-.74, ring-b .76, ring-c .70, pit-a .775, pit-b .77, margins .77)
and record it per variant. pit-b has a black band along its bottom edge; margins-a/b have a pencil ground line. Fighters' feet must read as
standing ON the floor in every variant at every viewport: on the margins pencil line exactly, on ring/pit slightly forward of the floor's back edge.

## Fit
New `js/stages.js`: data for stages and variants. Fit by scaling so the image covers the viewport AND its floor line lands on V.ground*s, no gaps at
top/bottom at any aspect (desktop 1440x900, ultrawide 2560x1080, phone portrait 390x844, phone landscape 844x390, small 360x640, tablet 820x1180).
Portrait crops to center. Keep existing arena math. Text-free art stays visible: remove the old LED band, perspective grid and cones when art is shown.
Keep the old procedural background as the fallback whenever an image fails or has not loaded yet (the game must be fully playable offline/slow/failed).

## Stages (each is more than a picture)
| id | name | wall hazard (reuses rope wall-hit logic) | wall hit word | finisher word | boss |
| ring | THE LIVE RING | existing electric ropes+posts | ZAP | LIGHTS OUT | THE BOUNCER |
| pit | THE PIT | iron spike racks drawn at arena edges, flames burst on impact | SPIKED | SENTENCED | THE WARDEN |
| margins | THE MARGINS | giant pink eraser block at each edge, leaves eraser crumbs and smudge | ERASED | SCRATCHED OUT | THE SCRIBBLE |

- Finisher: last enemy of a wave launched into the wall hazard gets extended slow-mo, the stage's big word and a bonus.
- One timed stage hazard on top of walls, telegraphed clearly and fair, hurts both sides, scored when it hits enemies, starts wave 2+:
  - ring: overhead spotlight rig short: floor patch electrified after a visible warning.
  - pit: floor flame jet from a stone seam after warning glow.
  - margins: giant hand-drawn hand with a pencil scribbles a floor line patch after a warning sketch (drawn in code, stylized, not creepy). Enemies in margins enter as if drawn on (brief pencil scribble).
- Boss per stage: same mechanics/AI as the Bouncer; HUD name changes and looks vary. #rr-boss label, banners, how-to all stay accurate.
- Ambient life on the main canvas, cheap (bounded, budget under ~1 ms on desktop, thin on phones, respects reduced motion), placed behind fighters:
  - ring: phone flashes twinkle, a row of near-silhouette crowd heads bobbing; crowd jumps on strikes/super.
  - pit: flames flicker over the painted bowls (positions per variant), embers rise, hooded figures sway.
  - margins: small doodled stick spectators on the ground-line edges cheering and dancing, wobbling "boil" line style, drawn ink.
- The Margins readability: player and everything white (fighter, sparks, rings, popups, flash, shadows, dust, RIOT super effects, enemy indicators) must be recolored
  via a per-stage palette so it reads on paper: player dark ink, enemies red pen. HUD, banner, tips, legend and touch buttons must remain legible over paper (add a plate or dark text as needed). The Pit/Ring HUD legible over their art too.

## Modes and picker
Title screen gains a location picker with 4 choices: THE RIOT SPREADS (infinite, default), THE LIVE RING, THE PIT, THE MARGINS. Thumbs for each, sharp cards, matching the game's existing display type and palette (#090A0F, #FF3E3E, no rounded glass, no purple).
Selecting one live-previews it behind the title (crossfade). Keep "any key starts" on title; Left/Right arrows change selection on desktop; cards are real buttons with visible focus and aria-pressed; tapping a card selects it and does not start a run; tap PLAY to start. Selection persists through storage.js; bad stored value falls back to default. `?stage=ring|pit|margins|infinite` deep link. COPY LINK shares the chosen location. The panel must fit without scrolling problems on 390x844, 360x640 and 844x390.

Single-location mode: endless waves in that location; variant changes after each boss.

THE RIOT SPREADS: endless, same run continues. Every 3 waves (never repeating the same location back to back; cycling through all 7 variants before any repeats; shuffle per run), the fight breaks through into the next location:
the last enemy cleared triggers slow-mo, the wipe travels from the side the body flew, debris, a heavy thud, then the new location with a banner "THE PIT" + wave number. Player's HP/score/multiplier/RIOT persist; no enemies are lost or stuck; no input drop. Difficulty keeps climbing past wave 50 with no NaN, no unbounded growth, no leak. Bosses still every 5th wave; if a break-through and boss wave coincide it still works.
No load hitch: preload next variant in advance and decode (img.decode/createImageBitmap); if not ready when due, keep fighting in current location until ready. Keep at most current + next decoded images. Transition under 0.9 s, and it does not repaint full screen outside the transition; reduced motion uses a plain crossfade. Pausing mid-transition, resizing mid-transition, dying mid-transition, restarting mid-transition all stay correct. Game-over panel shows Location/mode and LOCATIONS CROSSED in stats. Separate best score per mode (migrate old best to ring).

## Copy to update
index.html: pitch, NEW line, How to Play (stage hazards, modes), meta. Tips by stage (the "ROPES ARE LIVE" tip must not show in The Pit). Canonical/og URLs to https://ragdoll-riot.vercel.app and add `<meta name="robots" content="noindex">`. README: features, stages, modes, run/test; keep honest numbers only, replacing screenshots if you regenerate. Do not claim anything unmeasured.

## Tests
New `scripts/stages.mjs` wired into `npm test`, real browser (same harness style as features.mjs), covers at desktop and phone viewports: every stage+variant loads and fits (floor aligned, no gaps: sample pixels or expose debug fit data), picker keyboard/touch/persistence/deep link/bad stored value, each wall hazard word, timed hazard telegraph + hit, finisher, infinite transition across several forced locations (HP/score persist, enemies valid), all mid-transition edge cases, failed-image fallback (route abort), frame budget under stress in each stage, 60+ forced waves soak with no console errors and no growth in arrays. Save screenshots to .shots/ (gitignored): every stage on 1440x900 and 390x844, mid-fight, plus a mid-transition frame. Don't weaken any existing check; update a check only if its intent is still honored and say which.
Touches debug API in game.debug as needed (only under ?debug).

## Done means
`npm test` green; you looked at every screenshot (Read tool) and fixed what you saw. Do not git commit, push, or deploy; the orchestrator does.
