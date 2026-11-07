// Locations: data only (plus the small pure helpers that fit art and order the run).
// Coordinates marked "src" are fractions of the ORIGINAL 2752x1536 art; `crop` is the fraction of the
// source height kept by scripts/build-art.mjs (pit art has a black band along its bottom edge).
// Ambient points are [x, y] in src fractions, so they survive any crop and any output size.

export const STAGES = {
  ring: {
    id: 'ring', name: 'THE LIVE RING', boss: 'THE BOUNCER', wall: 'ZAP', finisher: 'LIGHTS OUT', stat: 'ROPE ZAPS',
    variants: ['ring-a', 'ring-b', 'ring-c'],
    hazardName: 'SPOTLIGHT RIG', hazardWord: 'SHOCKED',
    wallTip: 'THE ROPES ARE LIVE. LAUNCH ENEMIES INTO THEM FOR A ZAP BONUS.',
    hazardTip: 'A SPOTLIGHT LOCKS ONTO THE FLOOR. STEP OFF THE CIRCLE BEFORE IT FIRES.',
  },
  pit: {
    id: 'pit', name: 'THE PIT', boss: 'THE WARDEN', wall: 'SPIKED', finisher: 'SENTENCED', stat: 'SPIKE HITS',
    variants: ['pit-a', 'pit-b'],
    hazardName: 'FLAME JET', hazardWord: 'SCORCHED',
    wallTip: 'IRON SPIKES LINE THE WALLS. LAUNCH ENEMIES INTO THEM FOR A SPIKED BONUS.',
    hazardTip: 'A GLOWING CRACK IN THE FLOOR MEANS A FLAME JET. STEP OFF IT.',
  },
  margins: {
    id: 'margins', name: 'THE MARGINS', boss: 'THE SCRIBBLE', wall: 'ERASED', finisher: 'SCRATCHED OUT', stat: 'ERASURES',
    variants: ['margins-a', 'margins-b'],
    hazardName: 'THE HAND', hazardWord: 'SCRIBBLED',
    wallTip: 'GIANT ERASERS SIT AT THE EDGES. LAUNCH ENEMIES INTO THEM FOR AN ERASED BONUS.',
    hazardTip: 'A DOTTED PATCH ON THE LINE MEANS A GIANT HAND IS ABOUT TO SCRIBBLE IT OUT. MOVE.',
  },
};

const flares = (a) => a;
export const VARIANTS = {
  'ring-a': {
    stage: 'ring', floor: 0.73, crop: 1, crowdY: 0.69,
    flashes: flares([[.328, .39], [.358, .333], [.428, .41], [.539, .36], [.48, .333], [.375, .504], [.204, .482], [.244, .445], [.765, .457], [.959, .542], [.59, .358], [.675, .318]]),
  },
  'ring-b': {
    stage: 'ring', floor: 0.785, crop: 1, crowdY: 0.745,
    flashes: flares([[.16, .466], [.107, .488], [.125, .522], [.2, .51], [.245, .518], [.358, .536], [.423, .563], [.46, .585], [.598, .567], [.56, .584], [.754, .566], [.919, .59], [.845, .518], [.51, .512], [.655, .518]]),
  },
  'ring-c': {
    stage: 'ring', floor: 0.765, crop: 1, crowdY: 0.715,
    flashes: flares([[.259, .529], [.315, .522], [.419, .515], [.454, .587], [.232, .599], [.834, .466], [.686, .529], [.681, .556], [.842, .51], [.5, .48], [.62, .47]]),
  },
  'pit-a': {
    stage: 'pit', floor: 0.8, crop: 0.924, focusX: 0.34,   // focusX: the picture's x kept centred on a phone in portrait (statue + flames, not the dark arch)
    // flame base [x, y, size] over the painted bowls
    bowls: [[.1875, .535, 1.3], [.2975, .615, .8], [.3015, .31, 1], [.7025, .615, .8], [.8125, .535, 1.3], [.698, .31, 1], [.6025, .27, .9]],
    hoods: [[.235, .77, 1], [.765, .77, 1], [.33, .775, .8], [.67, .775, .8]],
  },
  'pit-b': {
    stage: 'pit', floor: 0.8, crop: 0.955, focusX: 0.3,
    bowls: [[.205, .64, 1.3], [.315, .70, .8], [.125, .325, 1], [.37, .30, .9], [.6275, .30, .9], [.8725, .325, 1], [.6825, .70, .8], [.79, .64, 1.3]],
    hoods: [[.165, .76, 1], [.835, .76, 1], [.28, .765, .8], [.72, .765, .8]],
  },
  'margins-a': { stage: 'margins', floor: 0.77, crop: 1, flatten: true },
  'margins-b': { stage: 'margins', floor: 0.77, crop: 1, flatten: true },
};

for (const [id, v] of Object.entries(VARIANTS)) {
  v.id = id; v.src = `art/${id}.webp`; v.thumb = `art/${id}-t.webp`;
  v.floorOut = v.floor / v.crop;   // floor line as a fraction of the OUTPUT image height
}

export const MODES = [
  { id: 'infinite', name: 'THE RIOT SPREADS', tag: 'ENDLESS', thumb: 'art/infinite-t.webp', stage: null,
    blurb: 'ENDLESS. EVERY 3 WAVES THE FIGHT BREAKS THROUGH INTO A NEW LOCATION.' },
  ...Object.values(STAGES).map((s) => ({ id: s.id, name: s.name, tag: s.boss.replace('THE ', 'BOSS '), thumb: VARIANTS[s.variants[0]].thumb, stage: s.id,
    blurb: { ring: 'ENDLESS WAVES IN THE ARENA. LIVE ROPES, A SPOTLIGHT RIG, AND THE BOUNCER.',
      pit: 'ENDLESS WAVES IN THE PIT. SPIKE RACKS, FLAME JETS, AND THE WARDEN.',
      margins: 'ENDLESS WAVES ON THE PAGE. ERASERS, A GIANT HAND, AND THE SCRIBBLE.' }[s.id] })),
];
export const DEFAULT_MODE = 'infinite';
export const isMode = (id) => MODES.some((m) => m.id === id);
export const modeOf = (id) => MODES.find((m) => m.id === id) || MODES[0];
export const stageOfVariant = (vid) => STAGES[VARIANTS[vid].stage];

/* ---------- run order ---------- */
// One cycle = all 7 variants once, shuffled, with no two neighbours from the same stage (so the banner
// always names a different place) and the first one not matching the stage we are standing in.
// `first` (optional) pins the variant the cycle starts with (a restart prefers a picture that is already decoded).
export function nextCycle(lastVariant, rnd = Math.random, first = null) {
  const ids = Object.keys(VARIANTS);
  const stage = (id) => VARIANTS[id].stage;
  for (let tries = 0; tries < 400; tries++) {
    const a = ids.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    if (first && VARIANTS[first]) { a.splice(a.indexOf(first), 1); a.unshift(first); }
    let ok = !lastVariant || stage(a[0]) !== stage(lastVariant);
    for (let i = 1; ok && i < a.length; i++) if (stage(a[i]) === stage(a[i - 1])) ok = false;
    if (ok) return a;
  }
  // practically unreachable: plain shuffle that at least avoids a direct variant repeat
  const a = ids.filter((id) => id !== lastVariant);
  return [...a, ...ids.filter((id) => id === lastVariant)];
}

/* ---------- fit ---------- */
// Scale an image so it covers the viewport AND its floor line (fraction f of image height) lands on screen
// y = gy. Horizontal: the picture's focal x (fraction of its width, 0.5 = centred) is centred on screen, clamped so
// there is never a gap. Only matters when the crop is narrower than the picture (phone portrait). Returns the draw rect.
export function fitCover(vw, vh, gy, iw, ih, f, fx = 0.5) {
  const k = Math.max(vw / iw, vh / ih, gy / (f * ih), (vh - gy) / ((1 - f) * ih));
  const ox = Math.min(0, Math.max(vw - iw * k, vw / 2 - fx * iw * k));
  return { k, ox, oy: gy - f * ih * k, iw, ih };
}
