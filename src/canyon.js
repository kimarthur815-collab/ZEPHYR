// Grand Canyon map: a procedurally carved, stepped canyon (real Grand Canyon strata order), a river,
// side canyons, a narrow horseshoe "course" canyon with rock pillars and an arch, junipers on the rims.
// Heights are generated on the GPU, read back once for collisions, and baked into shadow / AO / normal maps.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const L = 8192;          // map period along x (the canyon repeats seamlessly east-west)
const ZH = 4096;         // half extent along z
const RIM = 260, RIVER = -240, TONTO = -120;
const TILE = 512;

const k2 = (2 * Math.PI) / L;
const zc = (x) => 820 * Math.sin(k2 * x + 0.4) + 330 * Math.sin(3 * k2 * x + 1.3) + 120 * Math.sin(7 * k2 * x + 2.1);
const mod = (a, n) => ((a % n) + n) % n;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ── side canyons + the course canyon, as polylines of [x, z, halfWidthScale, floorU]
function catmull(ctrl, n) {
  const c = new THREE.CatmullRomCurve3(ctrl.map((p) => new THREE.Vector3(p[0], 0, p[1])));
  return c.getSpacedPoints(n - 1).map((v) => [v.x, v.z]);
}
function tributary(ctrl, n, w0, w1, f0, f1) {
  return catmull(ctrl, n).map((p, i, a) => { const s = i / (a.length - 1); return [p[0], p[1], w0 + (w1 - w0) * s, f0 + (f1 - f0) * s]; });
}
const COURSE_W = 170;
function buildTributaries() {
  const T = [];
  T.push(tributary([[900, zc(900) - 350], [760, zc(900) - 1200], [560, zc(900) - 2100]], 20, 420, 260, 0.1, 0.42));
  T.push(tributary([[4300, zc(4300) + 380], [4450, zc(4300) + 1300], [4750, zc(4300) + 2150]], 20, 380, 240, 0.12, 0.45));
  T.push(tributary([[5400, zc(5400) - 380], [5250, zc(5400) - 1250], [5350, zc(5400) - 2200]], 20, 360, 230, 0.12, 0.45));
  T.push(tributary([[6950, zc(6950) + 330], [7100, zc(6950) + 1100], [7350, zc(6950) + 1950]], 18, 320, 220, 0.15, 0.45));
  // the course: leaves the main canyon on the north side, loops round and comes back (a horseshoe)
  const a = 1700, b = 3050;
  T.push(tributary([
    [a - 40, zc(a) + 420], [a, zc(a) + 1100], [a + 120, zc(a) + 1900], [a + 520, zc(a) + 2450], [(a + b) / 2, zc(a) + 2600],
    [b - 480, zc(a) + 2450], [b - 120, zc(b) + 1900], [b, zc(b) + 1100], [b + 40, zc(b) + 420],
  ], 60, COURSE_W, COURSE_W, 0.3, 0.3));
  return T;
}

// ── GPU height generation (16-bit encoded) ─────────────────────────────────────────────
const NOISE_GLSL = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p, float P){ vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  float a = hash12(vec2(mod(i.x, P), i.y)), b = hash12(vec2(mod(i.x + 1., P), i.y));
  float c = hash12(vec2(mod(i.x, P), i.y + 1.)), d = hash12(vec2(mod(i.x + 1., P), i.y + 1.));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }
float fbm(vec2 xz, float scale, int oct){
  vec2 p = xz / scale; float P = ${L.toFixed(1)} / scale, s = 0., a = .5, n = 0.;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vn(p, P); n += a; p *= 2.; P *= 2.; a *= .5; }
  return s / n; }`;

const HEIGHT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec4 uPts[160];
uniform vec2 uRange[6];
uniform vec4 uBox[6];
uniform float uNT;
#define PI 3.14159265
${NOISE_GLSL}
float zc(float x){ float k = 2. * PI / ${L.toFixed(1)}; return 820. * sin(k * x + .4) + 330. * sin(3. * k * x + 1.3) + 120. * sin(7. * k * x + 2.1); }
float dzc(float x){ float k = 2. * PI / ${L.toFixed(1)}; return 820. * k * cos(k * x + .4) + 990. * k * cos(3. * k * x + 1.3) + 840. * k * cos(7. * k * x + 2.1); }
float cliff(float u, float a, float b){ float s = clamp((u - a) / (b - a), 0., 1.); return .82 * smoothstep(.25, .95, s) + .18 * s; }
float slp(float u, float a, float b){ float s = clamp((u - a) / (b - a), 0., 1.); return s * s * (3. - 2. * s); }
// stepped Grand Canyon profile, river -> rim (u = 0 at the river, 1 past the rim)
float profile(float u){
  float y = ${RIVER.toFixed(1)};
  y += 95. * cliff(u, .012, .075);   // inner gorge (Vishnu schist)
  y += 25. * slp(u, .08, .30);        // Tonto platform
  y += 130. * cliff(u, .30, .355);    // Redwall cliff
  y += 32. * cliff(u, .37, .425); y += 30. * cliff(u, .45, .50); y += 28. * cliff(u, .52, .565); // Supai steps
  y += 40. * slp(u, .58, .70);        // Hermit slope
  y += 62. * cliff(u, .70, .745);     // Coconino cliff
  y += 20. * slp(u, .76, .80);        // Toroweap
  y += 38. * cliff(u, .81, .855);     // Kaibab rim
  return y; }
float smin(float a, float b, float k){ float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
void main(){
  float x = vUv.x * ${L.toFixed(1)}, z = (vUv.y - .5) * ${(2 * ZH).toFixed(1)};
  vec2 xz = vec2(x, z);
  float W = 1250. + 220. * sin(4. * PI * x / ${L.toFixed(1)} + .7) + 360. * (fbm(xz, 1024., 3) - .5);
  float d = abs(z - zc(x)) / sqrt(1. + dzc(x) * dzc(x));
  float u = d / W;
  u += .44 * (fbm(xz + 37., 512., 4) - .5) * smoothstep(.08, .3, u);                    // bays and amphitheatres
  u += .2 * (fbm(xz + 211., 128., 3) - .5) * smoothstep(.5, .75, u);                     // ragged rim: small points and notches
  float rn = 1. - abs(fbm(xz + 911., 256., 4) * 2. - 1.);
  u += .6 * pow(rn, 5.) * smoothstep(.3, .45, u) * (1. - smoothstep(.8, .92, u));       // buttes left standing
  for (int t = 0; t < 6; t++) {
    if (float(t) >= uNT) break;
    vec4 bx = uBox[t];
    if (x < bx.x || x > bx.z || z < bx.y || z > bx.w) continue;
    int s0 = int(uRange[t].x), cnt = int(uRange[t].y);
    float ut = 1e9;
    for (int j = 0; j < 80; j++) {
      if (j >= cnt - 1) break;
      vec4 a = uPts[s0 + j], b = uPts[s0 + j + 1];
      vec2 ab = b.xy - a.xy, ap = xz - a.xy;
      float h = clamp(dot(ap, ab) / dot(ab, ab), 0., 1.);
      ut = min(ut, max(length(ap - ab * h) / mix(a.z, b.z, h), mix(a.w, b.w, h)));
    }
    u = smin(u, ut, .05);
  }
  float y = profile(u);
  float top = smoothstep(.84, 1.1, u);
  y += top * (22. * (fbm(xz + 5., 1024., 4) - .5) + 6. * (fbm(xz, 128., 3) - .5));
  y += (1. - top) * 2.4 * (fbm(xz + 71., 64., 3) - .5);
  float v = clamp((y + 400.) / 1000., 0., 1.) * 65535.;
  float hi = floor(v / 256.);
  gl_FragColor = vec4(hi / 255., floor(v - hi * 256.) / 255., 0., 1.);
}`;

// ── bake: R = sunlight (soft shadow), G = ambient occlusion, BA = normal.xz ───────────────
const BAKE_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tH; uniform vec3 uSun; uniform float uTexel;
float H(vec2 uv){ return texture2D(tH, uv).r; }
void main(){
  float cell = ${L.toFixed(1)} * uTexel, h = H(vUv);
  float hx = H(vUv + vec2(uTexel, 0.)) - H(vUv - vec2(uTexel, 0.));
  float hz = H(vUv + vec2(0., uTexel)) - H(vUv - vec2(0., uTexel));
  vec3 n = normalize(vec3(-hx, 2. * cell, -hz));
  vec2 sd = normalize(uSun.xz); float tanE = uSun.y / length(uSun.xz);
  float vis = 1., t = cell;
  for (int i = 0; i < 120; i++) {
    float th = H(vUv + sd * t / ${L.toFixed(1)});
    vis = min(vis, clamp((h + t * tanE + 1.5 - th) / (t * .025 + 2.), 0., 1.));
    t *= 1.065; if (t > 4200. || vis <= 0.) break;
  }
  float occ = 0.;
  for (int d = 0; d < 12; d++) {
    float a = float(d) * .5236 + .26; vec2 dir = vec2(cos(a), sin(a));
    float m = 0., r = cell * 1.5;
    for (int k = 0; k < 9; k++) { m = max(m, (H(vUv + dir * r / ${L.toFixed(1)}) - h) / r); r *= 1.85; }
    occ += m / sqrt(1. + m * m);
  }
  gl_FragColor = vec4(vis, clamp(1. - occ / 12. * 1.15, 0., 1.), n.x * .5 + .5, n.z * .5 + .5);
}`;

// ── shared rock look (terrain, pillars, arch) ───────────────────────────────────────
const ROCK_GLSL = `
uniform sampler2D tStrata; uniform sampler3D tNoise;
uniform vec3 uSun, uSunCol, uSky, uBounce;
uniform float uTime;
vec3 strataAt(vec3 w){
  float hs = w.y + (texture(tNoise, vec3(w.xz * .0007, .37)).r - .5) * 16.;
  vec3 c = texture2D(tStrata, vec2((hs + 250.) / 540., .5)).rgb;
  float fb = texture(tNoise, vec3(w.x * .0021, hs * .16, w.z * .0021)).g;  // thin beds inside each layer
  return c * (.84 + .3 * fb);
}
// resistant beds stick out as small ledges: lit tops, a dark line under each overhang
vec3 ledges(vec3 n, vec3 w, out float shade){
  float slope = 1. - n.y, steep = smoothstep(.3, .65, slope);
  vec4 q = texture(tNoise, vec3(w.xz * .004, w.y * .002 + .71));
  // uneven bed thickness (4-11 m) and only some beds stand out
  float ph = (w.y + (q.r - .5) * 9.) / (6.5 + (q.g - .5) * 7.);
  float f = fract(ph), strong = smoothstep(.35, .7, texture(tNoise, vec3(floor(ph) * .37, w.xz * .0015)).b);
  float top = smoothstep(.75, .97, f) * steep * strong;
  shade = 1. - .2 * steep * strong * smoothstep(.0, .12, f) * (1. - smoothstep(.12, .32, f));
  // vertical erosion grooves running down the cliffs
  float g1 = texture(tNoise, vec3(w.x * .045, w.y * .006, w.z * .045)).g - .5;
  float g2 = texture(tNoise, vec3(w.x * .11, w.y * .012, w.z * .11)).a - .5;
  vec3 t = normalize(vec3(-n.z, 0., n.x) + 1e-4);
  return normalize(n + vec3(0., top * 1.2, 0.) + t * (g1 * .9 + g2 * .5) * steep);
}
vec3 rockAlbedo(vec3 w, vec3 n){
  float slope = 1. - n.y;
  vec3 alb = strataAt(w);
  float streak = texture(tNoise, vec3(w.x * .025, w.y * .0035, w.z * .025)).b;
  alb *= mix(1., .62 + .5 * streak, smoothstep(.45, .85, slope));            // desert varnish down the cliffs
  alb *= .9 + .2 * texture(tNoise, w * .09).a;
  alb *= .82 + .36 * texture(tNoise, vec3(w.xz * .0018, w.y * .001 + .2)).r;   // big stains and colour patches
  return alb;
}
vec3 rockLight(vec3 alb, vec3 n, float sunV, float ao){
  float ndl = max(dot(n, uSun), 0.);
  ao = pow(ao, .7);
  // sky fill from above + warm light bounced off the sunlit red walls into the shadows
  vec3 amb = uSky * (.6 + .4 * n.y) * ao + uBounce * (1.1 - n.y) * (.35 + .65 * ao);
  return alb * (uSunCol * ndl * sunV + amb);
}`;

const TERRAIN_VERT = `
attribute vec2 aTile; attribute float aSkirt;
uniform sampler2D tH; uniform float uTileSize;
varying vec3 vW; varying vec2 vUv;
#include <fog_pars_vertex>
void main(){
  vec2 xz = aTile + position.xz * uTileSize;
  vec2 uv = vec2(xz.x / ${L.toFixed(1)}, xz.y / ${(2 * ZH).toFixed(1)} + .5);
  float h = texture2D(tH, uv).r - aSkirt * 45.;
  vec3 wp = vec3(xz.x, h, xz.y);
  vW = wp; vUv = uv;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const TERRAIN_FRAG = `
precision highp sampler3D;
uniform sampler2D tAux, tWeather;
uniform vec4 uCloud;
varying vec3 vW; varying vec2 vUv;
${ROCK_GLSL}
#include <fog_pars_fragment>
float cloudShadow(vec3 w){
  vec2 p = w.xz + uSun.xz / uSun.y * (uCloud.x - w.y);
  float r = texture2D(tWeather, (p + vec2(uTime * 3.5, uTime * 1.3)) / 7000.).r;
  float cov = smoothstep(.38 - uCloud.z, .72 - uCloud.z, r) * uCloud.y;
  return 1. - .72 * smoothstep(.3, .75, cov);
}
void main(){
  vec4 aux = texture2D(tAux, vUv);
  vec3 n = vec3(aux.b * 2. - 1., 0., aux.a * 2. - 1.); n.y = sqrt(max(1. - dot(n.xz, n.xz), 0.));
  vec3 dn = texture(tNoise, vW * .012).rgb + texture(tNoise, vW * .05).rgb * .5 - .75;
  n = normalize(n + vec3(dn.x, dn.y * .3, dn.z) * .28);
  float lsh; n = ledges(n, vW, lsh);
  vec3 alb = rockAlbedo(vW, n) * lsh;
  // flat ground: sage scrub and junipers on the rim, greyish green on the Tonto platform
  float flatg = smoothstep(.8, .95, n.y);
  float plat = smoothstep(${(RIM - 45).toFixed(1)}, ${(RIM - 20).toFixed(1)}, vW.y);
  float tonto = smoothstep(${(RIVER + 85).toFixed(1)}, ${(RIVER + 100).toFixed(1)}, vW.y) * (1. - smoothstep(${(RIVER + 125).toFixed(1)}, ${(RIVER + 135).toFixed(1)}, vW.y));
  float vg = texture(tNoise, vW * .03).r;
  float patchy = texture(tNoise, vW * .006).g;
  vec3 soil = mix(vec3(.56, .5, .4), vec3(.44, .43, .32), patchy);
  float canopy = smoothstep(.5, .7, texture(tNoise, vW * .045).r * .65 + texture(tNoise, vW * .012).g * .55 - .1 + plat * .1);
  vec3 veg = mix(soil, vec3(.13, .18, .1), canopy * .9);
  float gully = smoothstep(.62, .8, texture(tNoise, vec3(vW.xz * .02, .5)).g);
  float shrub = smoothstep(.62, .7, texture(tNoise, vW * .09).r);
  vec3 tontoC = mix(vec3(.4, .42, .33), vec3(.3, .34, .25), vg) * (1. - .35 * gully) * (1. - .45 * shrub);
  float talus = smoothstep(${(TONTO - 30).toFixed(1)}, ${(TONTO - 6).toFixed(1)}, vW.y);   // rubble shed from the Redwall above
  tontoC = mix(tontoC, vec3(.5, .3, .22), talus * .7);
  alb = mix(alb, veg, flatg * plat * .92);
  alb = mix(alb, tontoC, smoothstep(.6, .85, n.y) * tonto * .85);
  vec3 col = rockLight(alb, n, aux.r * cloudShadow(vW), aux.g);
  gl_FragColor = vec4(col, 1.);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// pillars / arch: same rock, shadows found by marching the height map toward the sun
const ROCK_VERT = `
varying vec3 vW, vN;
#include <fog_pars_vertex>
void main(){
  vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const ROCK_FRAG = `
precision highp sampler3D;
uniform sampler2D tH; uniform float uFloor;
varying vec3 vW, vN;
${ROCK_GLSL}
#include <fog_pars_fragment>
float march(vec3 p){
  vec2 sd = normalize(uSun.xz); float tanE = uSun.y / length(uSun.xz), vis = 1., t = 4.;
  for (int i = 0; i < 48; i++) {
    vec2 q = p.xz + sd * t;
    float th = texture2D(tH, vec2(q.x / ${L.toFixed(1)}, q.y / ${(2 * ZH).toFixed(1)} + .5)).r;
    vis = min(vis, clamp((p.y + t * tanE - th) / (t * .03 + 1.5), 0., 1.));
    t *= 1.12; if (t > 4000. || vis <= 0.) break;
  }
  return vis;
}
void main(){
  vec3 n = normalize(vN);
  vec3 dn = texture(tNoise, vW * .03).rgb - .5;
  n = normalize(n + dn * .35);
  float lsh; n = ledges(n, vW, lsh);
  float ao = .45 + .55 * smoothstep(uFloor, uFloor + 160., vW.y);
  vec3 col = rockLight(rockAlbedo(vW, n) * lsh, n, march(vW + n * 2.), ao);
  gl_FragColor = vec4(col, 1.);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const WATER_VERT = `
varying vec3 vW; varying vec2 vUv;
#include <fog_pars_vertex>
void main(){
  vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz;
  vUv = vec2(w.x / ${L.toFixed(1)}, w.z / ${(2 * ZH).toFixed(1)} + .5);
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_FRAG = `
precision highp sampler3D;
uniform sampler2D tAux; uniform sampler3D tNoise;
uniform vec3 uSun, uSunCol, uSkyTop, uSkyHor, uDeep; uniform float uTime;
varying vec3 vW; varying vec2 vUv;
#include <fog_pars_fragment>
void main(){
  vec3 V = normalize(cameraPosition - vW);
  vec2 p = vW.xz * .035; float t = uTime * .06;
  float a = texture(tNoise, vec3(p + vec2(t, 0.), .2)).r, b = texture(tNoise, vec3(p * 1.7 - vec2(0., t * 1.4), .6)).g;
  float c = texture(tNoise, vec3(p * 4.1 + vec2(t * 2., t), .9)).b;
  vec3 n = normalize(vec3((a - .5) * .35 + (c - .5) * .15, 1., (b - .5) * .35 + (c - .5) * .15));
  float fres = .03 + .97 * pow(1. - max(dot(n, V), 0.), 5.);
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uSkyHor, uSkyTop, clamp(R.y * 1.6, 0., 1.));
  float sunV = texture2D(tAux, vUv).r;
  vec3 col = mix(uDeep, sky * .65, fres * .85) + uSunCol * pow(max(dot(R, uSun), 0.), 220.) * 2.5 * sunV;
  gl_FragColor = vec4(col, 1.);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const QUAD_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';

// strata colour table (sRGB), bottom (river) to top (rim): Vishnu schist ... Kaibab limestone
const STRATA = [
  [-250, '#2f2a30'], [-210, '#463a40'], [-185, '#6b5052'], [-168, '#4b4045'], [-150, '#5d4c4a'], [-145, '#7d5c43'],
  [-138, '#848770'], [-126, '#949480'], [-121, '#8e8478'], [-116, '#9a7466'], [-80, '#a87a6a'], [-40, '#9e6a5a'],
  [-5, '#b06a52'], [8, '#a2563f'], [14, '#bd6a4b'], [30, '#cf8a64'], [38, '#b35b40'], [55, '#c9805d'], [70, '#a8513a'],
  [100, '#8e3c2b'], [138, '#7f3527'], [142, '#ddcaa6'], [175, '#e8d9ba'], [200, '#d8c6a2'], [205, '#a99076'],
  [214, '#bca487'], [222, '#cdbb9b'], [245, '#d9c8a8'], [262, '#c8b796'], [290, '#bfae8f'],
];
function makeStrata() {
  const W = 256, data = new Uint8Array(W * 4), cs = STRATA.map(([y, h]) => [y, new THREE.Color(h)]);
  for (let i = 0; i < W; i++) {
    const y = -250 + (i / (W - 1)) * 540;
    let k = 0; while (k < cs.length - 2 && cs[k + 1][0] < y) k++;
    const [y0, c0] = cs[k], [y1, c1] = cs[k + 1], t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    // Color() converted hex to linear; store sRGB bytes and let the GPU decode them
    const c = c0.clone().lerp(c1, t).convertLinearToSRGB();
    data.set([c.r * 255, c.g * 255, c.b * 255, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, W, 1);
  tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// unit tile grid (0..1 on x/z) with a skirt hanging down around the edge to hide LOD cracks
function tileGeometry(q) {
  const pos = [], skirt = [], idx = [], n = q + 1;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { pos.push(i / q, 0, j / q); skirt.push(0); }
  for (let j = 0; j < q; j++) for (let i = 0; i < q; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const edge = [];
  for (let i = 0; i < q; i++) edge.push(i);
  for (let j = 0; j < q; j++) edge.push(j * n + q);
  for (let i = q; i > 0; i--) edge.push(q * n + i);
  for (let j = q; j > 0; j--) edge.push(j * n);
  const base = pos.length / 3;
  edge.forEach((e) => { pos.push(pos[e * 3], 0, pos[e * 3 + 2]); skirt.push(1); });
  for (let k = 0; k < edge.length; k++) {
    const a = edge[k], b = edge[(k + 1) % edge.length], sa = base + k, sb = base + ((k + 1) % edge.length);
    idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb); // both sides
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
  g.setIndex(idx);
  return g;
}

export function createCanyon(renderer, { mobile, sun, noiseTex, weatherTex, colors }) {
  const N = 2048, texel = 1 / N;
  const tribs = buildTributaries();
  const course = tribs[tribs.length - 1];

  // ── 1. heights on the GPU, in horizontal strips (keeps each draw short on phones)
  const pts = [], ranges = [], boxes = [];
  for (const t of tribs) {
    ranges.push(new THREE.Vector2(pts.length / 4, t.length));
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (const p of t) { pts.push(...p); x0 = Math.min(x0, p[0] - p[2] * 1.3); x1 = Math.max(x1, p[0] + p[2] * 1.3); z0 = Math.min(z0, p[1] - p[2] * 1.3); z1 = Math.max(z1, p[1] + p[2] * 1.3); }
    boxes.push(new THREE.Vector4(x0, z0, x1, z1));
  }
  while (pts.length < 160 * 4) pts.push(0);
  while (ranges.length < 6) { ranges.push(new THREE.Vector2()); boxes.push(new THREE.Vector4()); }
  const ptsV = []; for (let i = 0; i < 160; i++) ptsV.push(new THREE.Vector4(pts[i * 4], pts[i * 4 + 1], pts[i * 4 + 2], pts[i * 4 + 3]));
  const hRT = new THREE.WebGLRenderTarget(N, N, { depthBuffer: false });
  const genQuad = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { uPts: { value: ptsV }, uRange: { value: ranges }, uBox: { value: boxes }, uNT: { value: tribs.length } },
    vertexShader: QUAD_VERT, fragmentShader: HEIGHT_FRAG,
  }));
  const prevRT = renderer.getRenderTarget();
  const strips = 8;
  hRT.scissorTest = true;
  for (let s = 0; s < strips; s++) {
    hRT.scissor.set(0, (s * N) / strips, N, N / strips);
    renderer.setRenderTarget(hRT); genQuad.render(renderer);
  }
  hRT.scissorTest = false;
  const raw = new Uint8Array(N * N * 4);
  renderer.readRenderTargetPixels(hRT, 0, 0, N, N, raw);
  genQuad.dispose(); hRT.dispose();
  const heights = new Float32Array(N * N), half = new Uint16Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const y = ((raw[i * 4] * 256 + raw[i * 4 + 1]) / 65535) * 1000 - 400;
    heights[i] = y; half[i] = THREE.DataUtils.toHalfFloat(y);
  }
  const hTex = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType);
  hTex.wrapS = THREE.RepeatWrapping; hTex.wrapT = THREE.ClampToEdgeWrapping;
  hTex.magFilter = hTex.minFilter = THREE.LinearFilter; hTex.generateMipmaps = false; hTex.needsUpdate = true;

  // ── 2. bake sunlight / AO / normals
  const auxRT = new THREE.WebGLRenderTarget(N, N, { depthBuffer: false });
  auxRT.texture.wrapS = THREE.RepeatWrapping; auxRT.texture.wrapT = THREE.ClampToEdgeWrapping;
  auxRT.texture.minFilter = auxRT.texture.magFilter = THREE.LinearFilter;
  const bakeQuad = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tH: { value: hTex }, uSun: { value: sun }, uTexel: { value: texel } },
    vertexShader: QUAD_VERT, fragmentShader: BAKE_FRAG,
  }));
  auxRT.scissorTest = true;
  for (let s = 0; s < strips; s++) {
    auxRT.scissor.set(0, (s * N) / strips, N, N / strips);
    renderer.setRenderTarget(auxRT); bakeQuad.render(renderer);
  }
  auxRT.scissorTest = false;
  const aux = new Uint8Array(N * N * 4);
  renderer.readRenderTargetPixels(auxRT, 0, 0, N, N, aux);
  bakeQuad.dispose();
  renderer.setRenderTarget(prevRT);

  // ── CPU queries
  const cell = L / N;
  const sampleH = (x, z) => {
    const fx = mod(x, L) / cell - 0.5, fz = Math.min(N - 1.001, Math.max(0, (z + ZH) / cell - 0.5));
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const i0 = mod(ix, N), i1 = mod(ix + 1, N), r0 = iz * N, r1 = Math.min(N - 1, iz + 1) * N;
    return (heights[r0 + i0] * (1 - tx) + heights[r0 + i1] * tx) * (1 - tz) + (heights[r1 + i0] * (1 - tx) + heights[r1 + i1] * tx) * tz;
  };
  const auxAt = (x, z, ch) => {
    const ix = mod(Math.floor(mod(x, L) / cell), N), iz = Math.min(N - 1, Math.max(0, Math.floor((z + ZH) / cell)));
    return aux[(iz * N + ix) * 4 + ch] / 255;
  };

  // ── 3. terrain: 512 m tiles around the camera, 4 detail levels, instanced
  const strata = makeStrata();
  const rockUniforms = {
    tStrata: { value: strata }, tNoise: { value: noiseTex },
    uSun: { value: sun }, uSunCol: { value: new THREE.Vector3(2.9, 1.95, 1.2) },
    uSky: { value: new THREE.Vector3(0.3, 0.34, 0.5) }, uBounce: { value: new THREE.Vector3(0.36, 0.2, 0.13) }, uTime: { value: 0 },
  };
  const terrainMat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      tH: { value: null }, tAux: { value: null }, tWeather: { value: null }, uTileSize: { value: TILE },
      uCloud: { value: new THREE.Vector4(1150, 0.62, 0.06, 1) },
    }]),
    vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG,
  });
  Object.assign(terrainMat.uniforms, rockUniforms); // share (merge would clone them)
  terrainMat.uniforms.tH.value = hTex; terrainMat.uniforms.tAux.value = auxRT.texture; terrainMat.uniforms.tWeather.value = weatherTex;

  const group = new THREE.Group();
  const QS = mobile ? [64, 32, 16, 8] : [128, 64, 32, 16];
  const R = mobile ? 8 : 10, RING = [1, 3, 6, R];
  const lods = QS.map((q) => {
    const g = tileGeometry(q);
    const maxInst = (2 * R + 1) ** 2;
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(maxInst * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aTile', attr); g.instanceCount = 0;
    const m = new THREE.Mesh(g, terrainMat); m.frustumCulled = false; group.add(m);
    return { g, attr };
  });
  // per-tile height range for culling (tiles of 128 texels)
  const TT = N / (L / TILE), tilesX = L / TILE, tilesZ = (2 * ZH) / TILE, tileMin = new Float32Array(tilesX * tilesZ), tileMax = new Float32Array(tilesX * tilesZ);
  for (let tz = 0; tz < tilesZ; tz++) for (let tx = 0; tx < tilesX; tx++) {
    let lo = 1e9, hi = -1e9;
    for (let j = tz * TT; j < (tz + 1) * TT; j += 2) for (let i = tx * TT; i < (tx + 1) * TT; i += 2) { const h = heights[j * N + i]; if (h < lo) lo = h; if (h > hi) hi = h; }
    tileMin[tz * tilesX + tx] = lo - 50; tileMax[tz * tilesX + tx] = hi + 5;
  }
  const frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), box = new THREE.Box3();

  // ── 4. river
  const water = new THREE.Mesh(new THREE.PlaneGeometry(26000, 26000).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      tAux: { value: null }, tNoise: { value: null }, uSun: { value: sun }, uSunCol: { value: new THREE.Vector3(2.6, 1.8, 1.1) },
      uSkyTop: { value: colors.zenith.clone() }, uSkyHor: { value: colors.horizon.clone() }, uDeep: { value: new THREE.Vector3(0.025, 0.07, 0.055) }, uTime: { value: 0 },
    }]),
    vertexShader: WATER_VERT, fragmentShader: WATER_FRAG,
  }));
  water.material.uniforms.tAux.value = auxRT.texture; water.material.uniforms.tNoise.value = noiseTex;
  water.position.y = RIVER + 10;
  group.add(water);

  // ── 5. rock pillars + arch in the course, junipers on the rims (two copies, for the x wrap)
  const rockMat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tH: { value: null }, uFloor: { value: TONTO } }]),
    vertexShader: ROCK_VERT, fragmentShader: ROCK_FRAG,
  });
  Object.assign(rockMat.uniforms, rockUniforms); rockMat.uniforms.tH.value = hTex;
  const props = new THREE.Group();
  const pillars = [];
  const rnd = (() => { let s = 1234567; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const jitter = (g, amt, seed) => {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = Math.sin(x * 0.37 + y * 0.21 + seed) * Math.cos(z * 0.29 - y * 0.17 + seed * 1.7);
      const k = 1 + n * amt;
      p.setXYZ(i, x * k, y, z * k);
    }
    g.computeVertexNormals();
    return g;
  };
  const cpts = course.map((p) => new THREE.Vector2(p[0], p[1]));
  const coursePoint = (s) => { // position + direction along the course polyline (0..1)
    const f = s * (cpts.length - 1), i = Math.min(cpts.length - 2, Math.floor(f)), t = f - i;
    const a = cpts[i], b = cpts[i + 1];
    return { p: a.clone().lerp(b, t), d: b.clone().sub(a).normalize() };
  };
  for (let k = 0; k < 13; k++) {
    const s = 0.08 + k * 0.068;
    if (Math.abs(s - 0.5) < 0.05) continue; // leave room under the arch
    const { p, d } = coursePoint(s);
    const side = (k % 2 ? 1 : -1) * (14 + rnd() * 18);
    const x = p.x - d.y * side, z = p.y + d.x * side;
    const r = 11 + rnd() * 9, h = 150 + rnd() * 120;
    const prof = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const bump = 1 + 0.14 * Math.sin(t * 22 + k) + (t > 0.85 ? 0.15 : 0); // ledges + a cap rock
      prof.push(new THREE.Vector2(r * (1 - 0.35 * t) * bump, t * h));
    }
    prof.push(new THREE.Vector2(0.01, h));
    const g = jitter(new THREE.LatheGeometry(prof, 18), 0.12, k * 3.1);
    const base = TONTO - 25;
    const m = new THREE.Mesh(g, rockMat);
    m.position.set(x, base, z); props.add(m);
    pillars.push({ x, z, r: r * 1.05, base, top: base + h });
  }
  // natural arch across the course at its far bend
  const { p: ap, d: ad } = coursePoint(0.5);
  const span = 82, archBase = TONTO + 70, archRise = 85;
  const archCurve = new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, i) => {
    const t = i / 8, s = (t - 0.5) * 2 * span;
    return new THREE.Vector3(ap.x - ad.y * s, archBase + archRise * Math.sin(t * Math.PI) - 25 * (Math.abs(s) > span * 0.9 ? 1 : 0), ap.y + ad.x * s);
  }));
  const archGeo = jitter(new THREE.TubeGeometry(archCurve, 64, 13, 14), 0.1, 7.7);
  props.add(new THREE.Mesh(archGeo, rockMat));
  const archPts = archCurve.getSpacedPoints(48);

  // junipers: small dark trees on flat rim ground and a few on the Tonto platform
  const treeGeo = (() => {
    const cone = new THREE.ConeGeometry(3.2, 7, 6, 1, true).translate(0, 5.5, 0);
    const cone2 = new THREE.ConeGeometry(2.4, 4.5, 6, 1, true).translate(0, 8.5, 0);
    const trunk = new THREE.CylinderGeometry(0.4, 0.6, 2.5, 5, 1, true).translate(0, 1.25, 0);
    const paint = (g, c) => { const n = g.attributes.position.count, col = new Float32Array(n * 3); const cc = new THREE.Color(c); for (let i = 0; i < n; i++) col.set([cc.r, cc.g, cc.b], i * 3); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); return g.toNonIndexed(); };
    return mergeGeometries([paint(cone, '#34472c'), paint(cone2, '#3d5233'), paint(trunk, '#4a3a2c')].map((g) => { g.deleteAttribute('uv'); return g; }));
  })();
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const maxTrees = mobile ? 5000 : 14000;
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, maxTrees);
  let nt = 0;
  const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();
  for (let tries = 0; tries < maxTrees * 12 && nt < maxTrees; tries++) {
    const x = rnd() * L, z = (rnd() * 2 - 1) * 3600, y = sampleH(x, z);
    const sl = Math.abs(sampleH(x + 6, z) - sampleH(x - 6, z)) + Math.abs(sampleH(x, z + 6) - sampleH(x, z - 6));
    const onRim = y > RIM - 30 && sl < 3.5, onTonto = y > RIVER + 90 && y < RIVER + 128 && sl < 2.5;
    if (!(onRim && rnd() < 0.85) && !(onTonto && rnd() < 0.12)) continue;
    const s = 0.7 + rnd() * 0.8;
    _m.compose(_p.set(x, y - 0.5, z), _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28), _s.set(s, s * (0.8 + rnd() * 0.5), s));
    trees.setMatrixAt(nt, _m);
    const lit = 0.3 + 0.7 * auxAt(x, z, 0);
    trees.setColorAt(nt, _c.setRGB(lit * (0.85 + rnd() * 0.3), lit, lit * (0.85 + rnd() * 0.2)));
    nt++;
  }
  trees.count = nt; trees.frustumCulled = false;
  props.add(trees);
  const props2 = props.clone(); // second copy for the seamless wrap
  group.add(props, props2);

  // ── 6. thermals over the canyon, spawn point
  const thermalSpots = [];
  for (let k = 0; k < 7; k++) {
    const x = 1350 + k * 1170 + (k === 0 ? -250 : 0);
    thermalSpots.push({ x: mod(x, L), z: zc(x) + (k % 2 ? 260 : -220) });
  }
  const spawn = { x: 1350, y: 140, z: zc(1350) + 120, heading: -Math.PI / 2 };

  // distance to the course centre-line (for "entering the course" messages)
  const courseDist = (x, z) => {
    const lx = mod(x, L); let best = 1e9;
    for (let i = 0; i < cpts.length - 1; i++) {
      const a = cpts[i], b = cpts[i + 1], abx = b.x - a.x, abz = b.y - a.y;
      const h = Math.max(0, Math.min(1, ((lx - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz)));
      best = Math.min(best, Math.hypot(lx - a.x - abx * h, z - a.y - abz * h));
    }
    return best;
  };

  return {
    group, spawn, thermalSpots, rim: RIM, river: RIVER, period: L,
    courseAt(s) { const { p, d } = coursePoint(s); return { x: p.x, z: p.y, dx: d.x, dz: d.y }; },
    heightAt: sampleH,
    // how much direct sun reaches a point in the air (for lighting the glider)
    sunAt(p) {
      const sd = Math.hypot(sun.x, sun.z), dx = sun.x / sd, dz = sun.z / sd, tanE = sun.y / sd;
      let vis = 1, t = 6;
      for (let i = 0; i < 40 && t < 3500; i++, t *= 1.13) {
        const th = sampleH(p.x + dx * t, p.z + dz * t);
        vis = Math.min(vis, Math.min(1, Math.max(0, (p.y + t * tanE - th) / (t * 0.03 + 2))));
        if (vis <= 0) break;
      }
      return vis;
    },
    inCourse(p) { return courseDist(p.x, p.z) < COURSE_W * 0.85 && p.y < RIM; },
    // soft collisions; returns 'river' when the glider fell into the water
    collide(P) {
      const p = P.pos, h = sampleH(p.x, p.z);
      if (p.y < RIVER + 14 && h < RIVER + 16) return 'river';
      let hit = false;
      if (p.y < h + 3) {
        const gx = (sampleH(p.x + 4, p.z) - sampleH(p.x - 4, p.z)) / 8, gz = (sampleH(p.x, p.z + 4) - sampleH(p.x, p.z - 4)) / 8, g = Math.hypot(gx, gz);
        if (g < 0.8) { p.y = h + 3; P.vy = Math.max(P.vy, 3); }
        else { // a wall: step back down the slope until clear of it
          for (let k = 0; k < 16 && sampleH(p.x, p.z) > p.y - 2; k++) { p.x -= (gx / g) * 3; p.z -= (gz / g) * 3; }
        }
        hit = true;
      }
      const lx = mod(p.x, L);
      for (const q of pillars) {
        const dx = lx - q.x, dz = p.z - q.z, d = Math.hypot(dx, dz);
        if (d < q.r + 3 && p.y < q.top + 2 && p.y > q.base) { p.x += (dx / d) * (q.r + 3 - d); p.z += (dz / d) * (q.r + 3 - d); hit = true; }
      }
      for (const a of archPts) {
        const dx = lx - a.x, dy = p.y - a.y, dz = p.z - a.z, d = Math.hypot(dx, dy, dz);
        if (d < 16) { const k = (16 - d) / d; p.x += dx * k; p.y += dy * k; p.z += dz * k; hit = true; break; }
      }
      if (hit) P.speed = Math.max(18, P.speed * 0.65);
      return hit ? 'bump' : null;
    },
    update(camera, t) {
      rockUniforms.uTime.value = t; water.material.uniforms.uTime.value = t;
      const cp = camera.position;
      water.position.x = Math.round(cp.x / 64) * 64; water.position.z = Math.round(cp.z / 64) * 64;
      const base = Math.floor(cp.x / L) * L;
      props.position.x = base; props2.position.x = base + (cp.x - base < L / 2 ? -L : L);
      // choose terrain tiles: detail by ring distance, skip the ones outside the view
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const ci = Math.floor(cp.x / TILE), cj = Math.floor(cp.z / TILE), counts = [0, 0, 0, 0];
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const ring = Math.max(Math.abs(di), Math.abs(dj));
        const lod = ring <= RING[0] ? 0 : ring <= RING[1] ? 1 : ring <= RING[2] ? 2 : 3;
        const ti = ci + di, tj = cj + dj, x0 = ti * TILE, z0 = tj * TILE;
        const tz = tj + tilesZ / 2, tx = mod(ti, tilesX);
        const lo = tz >= 0 && tz < tilesZ ? tileMin[tz * tilesX + tx] : RIM - 80, hi = tz >= 0 && tz < tilesZ ? tileMax[tz * tilesX + tx] : RIM + 40;
        box.min.set(x0, lo, z0); box.max.set(x0 + TILE, hi, z0 + TILE);
        if (ring > 1 && !frustum.intersectsBox(box)) continue;
        const L_ = lods[lod], k = counts[lod]++;
        L_.attr.array[k * 2] = x0; L_.attr.array[k * 2 + 1] = z0;
      }
      lods.forEach((l, i) => { l.g.instanceCount = counts[i]; l.attr.needsUpdate = true; });
    },
  };
}
