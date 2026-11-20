import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createAudio } from './audio.js';
import { createVolumetricClouds } from './clouds.js';

// volumetric clouds: 1 = 노을 운해 (default). #clouds-2 / #clouds-3 still show the other candidates.
const CLOUD_PRESET = (location.hash.match(/^#clouds-([123])$/) || [])[1] || '1';
addEventListener('hashchange', () => location.reload());
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// ───────────────────────── utils
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const dampAngle = (a, b, l, dt) => {
  const d = ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * (1 - Math.exp(-l * dt));
};
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hash2 = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); };
const hash3 = (a, b, c) => { const h = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453; return h - Math.floor(h); };
function vnoise(x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const w = (i, j) => {
    let a = xi + i, b = yi + j;
    if (period) { a = ((a % period) + period) % period; b = ((b % period) + period) % period; }
    return hash2(a, b);
  };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(w(0, 0), w(1, 0), u), lerp(w(0, 1), w(1, 1), u), v);
}
function fbm(x, y, oct = 4, period = 0) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, period ? period * f : 0); n += a; a *= 0.5; f *= 2; }
  return s / n;
}
const wrap = (v, c, F) => v + F * Math.round((c - v) / F);

// ───────────────────────── quality tier
const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches;
const Q = isTouch
  ? { pr: 1.5, sea: 300, clusters: 24, puffs: 6, islandsPer: 4, aa: false }
  : { pr: 2, sea: 680, clusters: 44, puffs: 7, islandsPer: 7, aa: true };

// ───────────────────────── palette & sun
const C = {
  zenith: new THREE.Color('#3a63ad'),
  mid: new THREE.Color('#a4bde0'),
  horizon: new THREE.Color('#f2dace'),
  glow: new THREE.Color('#ffa868'),
  sun: new THREE.Color('#fff4dc'),
  cloudLit: new THREE.Color('#fff4ea'),
  cloudShade: new THREE.Color('#b2a3c4'),
  cloudRim: new THREE.Color('#ffc387'),
};
const SUN = new THREE.Vector3(-0.42, 0.2, -1).normalize();
const f3 = (v) => `vec3(${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)})`;
const c3 = (c) => `vec3(${c.r.toFixed(5)},${c.g.toFixed(5)},${c.b.toFixed(5)})`;

// Fog that picks up the sun glow, so the sky and fogged distance meet without a seam.
const GLOW_GLSL = `(pow(fs,6.0)*0.45 + pow(fs,40.0)*0.55)`;
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogDir;\n#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogDir = mvPosition.xyz * mat3(viewMatrix);\n#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
 uniform vec3 fogColor; varying float vFogDepth; varying vec3 vFogDir;
 #ifdef FOG_EXP2
  uniform float fogDensity;
 #else
  uniform float fogNear; uniform float fogFar;
 #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
 #ifdef FOG_EXP2
  float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
 #else
  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
 #endif
 float fs = max(dot(normalize(vFogDir), ${f3(SUN)}), 0.0);
 vec3 fcol = fogColor + ${c3(C.glow)} * ${GLOW_GLSL};
 gl_FragColor.rgb = mix( gl_FragColor.rgb, fcol, fogFactor );
#endif`;

// ───────────────────────── renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio || 1, Q.pr);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(C.horizon, 0.00066);
const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.5, 9000);

// post: HDR render target (MSAA on desktop) -> bloom -> tone mapping
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth * pixelRatio, innerHeight * pixelRatio, {
  type: THREE.HalfFloatType, samples: Q.aa ? 4 : 0,
  depthTexture: CLOUD_PRESET ? new THREE.DepthTexture(innerWidth * pixelRatio, innerHeight * pixelRatio) : null, // volumetric clouds stop at the scene's depth
}));
// the composer clones its buffer, and the clone would share the same depth texture; the cloud pass reads one
// buffer's depth while drawing into the other, so each needs its own (otherwise phones render black)
if (CLOUD_PRESET) composer.renderTarget2.depthTexture = new THREE.DepthTexture(innerWidth * pixelRatio, innerHeight * pixelRatio);
composer.setPixelRatio(pixelRatio);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const vol = CLOUD_PRESET
  ? createVolumetricClouds(renderer, camera, CLOUD_PRESET, { mobile: isTouch, sun: SUN, fogColor: C.horizon, glowColor: C.glow, fogDensity: scene.fog.density })
  : null;
if (vol) composer.addPass(vol.pass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.55, 1.1);
composer.addPass(bloom);
if (vol) bloom.threshold = 1.35; // bright cloud tops shouldn't glow, only the sun and silver linings
composer.addPass(new OutputPass());

// The game lives in #root. When the phone's own auto-rotate turns the browser away from the mode the
// player picked, #root is rotated back with CSS so the game stays put (and works with rotation lock on).
const rootEl = document.getElementById('root');
let gameAngle = null; // device -> game screen angle in degrees (0 portrait, 90/270 landscape), set by mode choice
let rot = 0, VW = innerWidth, VH = innerHeight;
const browserAngle = () => {
  const a = screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : window.orientation || 0;
  return ((a % 360) + 360) % 360;
};
function layout() {
  rot = gameAngle == null ? 0 : (((gameAngle - browserAngle()) % 360) + 360) % 360;
  const W = innerWidth, H = innerHeight, swap = rot === 90 || rot === 270;
  VW = swap ? H : W; VH = swap ? W : H;
  rootEl.style.width = VW + 'px'; rootEl.style.height = VH + 'px';
  rootEl.style.transform = rot === 90 ? `translate(${W}px,0) rotate(90deg)` : rot === 180 ? `translate(${W}px,${H}px) rotate(180deg)` : rot === 270 ? `translate(0,${H}px) rotate(270deg)` : 'none';
  camera.aspect = VW / VH; camera.updateProjectionMatrix();
  renderer.setSize(VW, VH); composer.setSize(VW, VH);
}
// browser (client) coords -> game coords inside #root
function toLocal(x, y) {
  const W = innerWidth, H = innerHeight;
  return rot === 90 ? [y, W - x] : rot === 180 ? [W - x, H - y] : rot === 270 ? [H - y, x] : [x, y];
}

const sunLight = new THREE.DirectionalLight('#ffd6ad', 2.6);
sunLight.position.copy(SUN).multiplyScalar(100);
scene.add(sunLight);
scene.add(new THREE.HemisphereLight('#a8c4ec', '#e8b99a', 0.85));

// ───────────────────────── sky
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(6000, 48, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uZenith: { value: C.zenith }, uMid: { value: C.mid }, uHorizon: { value: C.horizon },
      uGlow: { value: C.glow }, uSunC: { value: C.sun }, uSun: { value: SUN },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uZenith, uMid, uHorizon, uGlow, uSunC, uSun; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.16, h));
        col = mix(col, uZenith, smoothstep(0.12, 0.7, h));
        col = mix(col, uHorizon, exp(-max(h, 0.0) * 28.0) * 0.85);
        col = mix(col, uHorizon, smoothstep(0.0, -0.05, h));
        float fs = max(dot(d, uSun), 0.0);
        col += uGlow * ${GLOW_GLSL};
        col += uGlow * pow(fs, 3.0) * smoothstep(0.0, 0.25, h) * 0.18;
        col += uSunC * pow(fs, 900.0) * 1.2;
        col = mix(col, uSunC * 4.0, smoothstep(0.99972, 0.99986, fs));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -10;
scene.add(sky);
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(sky.geometry, sky.material));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(5000, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#e9dade' }));
  floor.position.y = -300; envScene.add(floor);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02, 1, 12000).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

// ───────────────────────── cloud sea floor
function makeSeaTex() {
  const S = 256, d = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const n = fbm((i / S) * 8, (j / S) * 8, 4, 8);
    const b = 0.78 + 0.22 * smooth(0.3, 0.75, n);
    const k = (j * S + i) * 4; d[k] = d[k + 1] = d[k + 2] = b * 255; d[k + 3] = 255;
  }
  const t = new THREE.DataTexture(d, S, S);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
const SEA_SIZE = 18000, SEA_TILE = 450, SEA_Y = -45;
const seaTex = makeSeaTex();
seaTex.repeat.set(SEA_SIZE / SEA_TILE, SEA_SIZE / SEA_TILE);
const sea = new THREE.Mesh(
  new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#ecdde0', map: seaTex })
);
scene.add(sea);

// ───────────────────────── cloud puffs (billboards, CPU sorted)
function makeCloudAtlas() {
  const S = 512, half = 256, data = new Uint8Array(S * S * 4), R = rng(11);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * half, oy = Math.floor(v / 2) * half;
    const blobs = [], n = 10 + Math.floor(R() * 6);
    for (let i = 0; i < n; i++) {
      const bx = 0.22 + R() * 0.56;
      const by = 0.3 + R() * 0.26 + (1 - Math.abs(bx - 0.5) * 2) * 0.12;
      const br = 0.09 + R() * 0.13 * (1 - Math.abs(bx - 0.5));
      blobs.push(bx, by, br);
    }
    const dens = (x, y) => {
      let d = 0;
      for (let b = 0; b < blobs.length; b += 3) {
        const dx = x - blobs[b], dy = (y - blobs[b + 1]) * 1.15, r = blobs[b + 2];
        d += Math.exp(-(dx * dx + dy * dy) / (r * r));
      }
      d *= smooth(0.2, 0.34, y);
      return d * (0.65 + 0.7 * fbm(x * 7 + v * 13, y * 7, 3));
    };
    // treat density as a height field and light it like a puffy surface (sun from above-front)
    const e = 2 / half, Lx = 0.0, Ly = 0.72, Lz = 0.69;
    for (let j = 0; j < half; j++) for (let i = 0; i < half; i++) {
      const x = (i + 0.5) / half, y = (j + 0.5) / half;
      const d = dens(x, y);
      let a = smooth(0.18, 0.75, d);
      a *= smooth(0, 0.06, x) * smooth(1, 0.94, x) * smooth(0, 0.06, y) * smooth(1, 0.94, y);
      let lit = 1;
      if (a > 0.003) {
        const hgt = (q) => Math.sqrt(Math.max(q, 0));
        const gx = (hgt(dens(x + e, y)) - hgt(dens(x - e, y))) / (2 * e);
        const gy = (hgt(dens(x, y + e)) - hgt(dens(x, y - e))) / (2 * e);
        const k = 0.09, nl = Math.hypot(-gx * k, -gy * k, 1);
        const ndl = ((-gx * k) * Lx + (-gy * k) * Ly + Lz) / nl;
        lit = clamp(0.25 + 0.75 * ndl, 0, 1) * (0.72 + 0.28 * smooth(0.25, 0.8, y));
      }
      const k = ((oy + j) * S + (ox + i)) * 4;
      data[k] = lit * 255; data[k + 1] = clamp(d, 0, 1) * 255; data[k + 2] = 0; data[k + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

const R0 = rng(2026);
const puffs = []; // {x,y,z,s,v,o,F}
const clusters = []; // {x,y,z,r,F}
const F_SEA = 3800, F_CU = 4400;
for (let i = 0; i < Q.sea; i++) {
  puffs.push({ x: (R0() - 0.5) * F_SEA, y: -12 + R0() * 36, z: (R0() - 0.5) * F_SEA,
    s: (isTouch ? 180 : 140) + R0() * 170, v: Math.floor(R0() * 4), o: 0.72 + R0() * 0.22, F: F_SEA });
}
for (let c = 0; c < Q.clusters; c++) {
  let x, z, y;
  do { x = (R0() - 0.5) * F_CU; z = (R0() - 0.5) * F_CU; y = 160 + R0() * 300; } while (Math.hypot(x, z) < 320);
  const cr = 55 + R0() * 70;
  clusters.push({ x, y, z, r: cr, F: F_CU });
  for (let k = 0; k < Q.puffs; k++) {
    puffs.push({ x: x + (R0() - 0.5) * 1.8 * cr, y: y + (R0() * 0.9 - 0.15) * cr * 0.55, z: z + (R0() - 0.5) * 1.8 * cr,
      s: cr * (0.8 + R0() * 0.6), v: Math.floor(R0() * 4), o: 0.92, F: F_CU });
  }
}
const NP = puffs.length;
const cloudGeo = new THREE.InstancedBufferGeometry();
cloudGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
cloudGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
cloudGeo.setIndex([0, 1, 2, 0, 2, 3]);
const aOff = new THREE.InstancedBufferAttribute(new Float32Array(NP * 4), 4).setUsage(THREE.DynamicDrawUsage);
const aVar = new THREE.InstancedBufferAttribute(new Float32Array(NP * 2), 2).setUsage(THREE.DynamicDrawUsage);
cloudGeo.setAttribute('aOff', aOff);
cloudGeo.setAttribute('aVar', aVar);
cloudGeo.instanceCount = NP;
const cloudMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, fog: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTex: { value: null }, uSun: { value: SUN },
    uLit: { value: C.cloudLit }, uShade: { value: C.cloudShade }, uRim: { value: C.cloudRim },
  }]),
  vertexShader: `
    attribute vec4 aOff; attribute vec2 aVar;
    varying vec2 vUv; varying float vA; varying float vVar; varying vec3 vView; varying float vWY;
    #include <fog_pars_vertex>
    void main(){
      vec3 p = aOff.xyz; float s = aOff.w;
      vec3 vd = p - cameraPosition; float dist = length(vd); vd /= dist;
      vec3 right = normalize(cross(vd, vec3(0.0011, 1.0, 0.0)));
      vec3 up = cross(right, vd);
      vec3 wp = p + right * position.x * s * 1.55 + up * position.y * s;
      vUv = uv; vVar = aVar.x; vView = vd; vWY = wp.y;
      vA = aVar.y * smoothstep(s * 0.3, s * 1.1, dist);
      vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: `
    uniform sampler2D uTex; uniform vec3 uSun, uLit, uShade, uRim;
    varying vec2 vUv; varying float vA; varying float vVar; varying vec3 vView; varying float vWY;
    #include <fog_pars_fragment>
    void main(){
      float vv = floor(vVar + 0.5);
      vec2 uv = vUv * 0.5 + vec2(mod(vv, 2.0), floor(vv * 0.5 + 0.01)) * 0.5;
      vec4 t = texture2D(uTex, uv);
      float a = t.a * vA * smoothstep(-45.0, 5.0, vWY);
      if (a < 0.004) discard;
      float toward = max(dot(vView, uSun), 0.0);
      float lit = t.r * (1.0 - 0.3 * toward);
      vec3 col = mix(uShade, uLit, lit);
      float back = pow(toward, 5.0);
      col += uRim * back * (1.0 - t.a) * 1.6 + uRim * back * 0.2;
      gl_FragColor = vec4(col, a);
      #include <fog_fragment>
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
cloudMat.uniforms.uTex.value = makeCloudAtlas();
const clouds = new THREE.Mesh(cloudGeo, cloudMat);
clouds.frustumCulled = false;
clouds.renderOrder = 5;
scene.add(clouds);
if (vol) { clouds.visible = false; sea.material.map = null; sea.material.color.set(vol.preset.floor); }

const pWX = new Float32Array(NP), pWZ = new Float32Array(NP), pD = new Float32Array(NP), pE = new Float32Array(NP);
const order = Array.from({ length: NP }, (_, i) => i);
function updateClouds(cp) {
  for (let i = 0; i < NP; i++) {
    const p = puffs[i];
    const x = wrap(p.x, cp.x, p.F), z = wrap(p.z, cp.z, p.F);
    pWX[i] = x; pWZ[i] = z;
    const dx = x - cp.x, dy = p.y - cp.y, dz = z - cp.z;
    pD[i] = dx * dx + dy * dy + dz * dz;
    pE[i] = 1 - smooth(p.F * 0.38, p.F * 0.5, Math.hypot(dx, dz));
  }
  order.sort((a, b) => pD[b] - pD[a]);
  const o = aOff.array, v = aVar.array;
  for (let k = 0; k < NP; k++) {
    const i = order[k], p = puffs[i];
    o[k * 4] = pWX[i]; o[k * 4 + 1] = p.y; o[k * 4 + 2] = pWZ[i]; o[k * 4 + 3] = p.s;
    v[k * 2] = p.v; v[k * 2 + 1] = p.o * pE[i];
  }
  aOff.needsUpdate = true; aVar.needsUpdate = true;
}

// ───────────────────────── floating islands
function makeIslandGeo(seed) {
  const R = rng(seed), r = 60, h = 95 + R() * 55;
  const cTop = new THREE.Color('#c99f7e'), cMid = new THREE.Color('#9a7468'), cBot = new THREE.Color('#584a6e');
  const parts = [];
  const paint = (g, fn) => {
    g = g.index ? g.toNonIndexed() : g;
    g.computeVertexNormals();
    const pos = g.attributes.position, nor = g.attributes.normal, col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 3) {
      const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const c = fn(cy, nor.getY(i), R());
      for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r; col[(i + k) * 3 + 1] = c.g; col[(i + k) * 3 + 2] = c.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  // rock body
  let rock = new THREE.ConeGeometry(r, h, 9, 5);
  rock.rotateX(Math.PI); rock.translate(0, -h / 2, 0);
  const p = rock.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = smooth(0, -h * 0.15, y);
    const a = Math.round(x * 10), b = Math.round(y * 10), c = Math.round(z * 10);
    x *= 1 + (hash3(a, b, c + seed) - 0.5) * 0.55 * k;
    z *= 1 + (hash3(c, a, b + seed) - 0.5) * 0.55 * k;
    y += (hash3(b, c, a + seed) - 0.5) * h * 0.09 * k;
    p.setXYZ(i, x, y, z);
  }
  parts.push(paint(rock, (cy, ny, rr) => {
    const t = clamp(-cy / h, 0, 1);
    const c = t < 0.45 ? cTop.clone().lerp(cMid, t / 0.45) : cMid.clone().lerp(cBot, (t - 0.45) / 0.55);
    return c.multiplyScalar(0.92 + rr * 0.14);
  }));
  // grass cap
  const cap = new THREE.CylinderGeometry(r * 1.05, r * 0.96, 5, 9, 1);
  cap.translate(0, 2, 0);
  const cp = cap.attributes.position;
  for (let i = 0; i < cp.count; i++) if (cp.getY(i) > 3) {
    const a = Math.round(cp.getX(i) * 10), c = Math.round(cp.getZ(i) * 10);
    cp.setY(i, cp.getY(i) + hash3(a, c, seed) * 2.2);
  }
  const g1 = new THREE.Color('#8cbf5f'), g2 = new THREE.Color('#a9d06c'), earth = new THREE.Color('#7b5c48');
  parts.push(paint(cap, (cy, ny, rr) => (ny > 0.5 ? g1.clone().lerp(g2, rr) : earth.clone().multiplyScalar(0.9 + rr * 0.2))));
  // trees
  const greens = ['#3f7a4a', '#4f8f50', '#5f9d55', '#e0a04a'].map((c) => new THREE.Color(c));
  const nt = 4 + Math.floor(R() * 7);
  for (let i = 0; i < nt; i++) {
    const ang = R() * Math.PI * 2, d = Math.sqrt(R()) * r * 0.78;
    const tx = Math.cos(ang) * d, tz = Math.sin(ang) * d, th = 12 + R() * 10;
    const trunk = new THREE.CylinderGeometry(0.8, 1.2, 6, 5); trunk.translate(tx, 7, tz);
    parts.push(paint(trunk, () => new THREE.Color('#6b4a3a')));
    const crown = R() < 0.65 ? new THREE.ConeGeometry(4.5 + R() * 3, th, 6) : new THREE.IcosahedronGeometry(5 + R() * 2.5, 0);
    crown.translate(tx, 9 + th / 2 - (crown.type === 'IcosahedronGeometry' ? th / 2 - 4 : 0), tz);
    const gc = greens[R() < 0.12 ? 3 : Math.floor(R() * 3)];
    parts.push(paint(crown, (cy, ny, rr) => gc.clone().multiplyScalar(0.85 + rr * 0.25 + Math.max(ny, 0) * 0.15)));
  }
  return { geo: mergeGeometries(parts), r, h, top: 5 };
}

const islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
const VARIANTS = 6, F_IS = 4600;
const islandVariants = [], islands = [];
const R1 = rng(77);
for (let v = 0; v < VARIANTS; v++) {
  const iv = makeIslandGeo(1000 + v * 17);
  const mesh = new THREE.InstancedMesh(iv.geo, islandMat, Q.islandsPer);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  scene.add(mesh);
  islandVariants.push({ ...iv, mesh });
  for (let k = 0; k < Q.islandsPer; k++) {
    let x, z, y;
    do { x = (R1() - 0.5) * F_IS; z = (R1() - 0.5) * F_IS; y = 120 + R1() * 330; } while (Math.hypot(x, z) < 260);
    islands.push({ v, k, x, y, z, s: 0.55 + R1() * 1.0, rot: R1() * Math.PI * 2, ph: R1() * 6.28, wx: 0, wy: 0, wz: 0, ws: 1 });
  }
}
Object.assign(islands[0], { x: 260, z: -820, y: 235, s: 1.5 });
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
function updateIslands(cp, t) {
  for (const is of islands) {
    is.wx = wrap(is.x, cp.x, F_IS); is.wz = wrap(is.z, cp.z, F_IS);
    is.wy = is.y + Math.sin(t * 0.25 + is.ph) * 2.5;
    is.ws = is.s * (1 - smooth(F_IS * 0.4, F_IS * 0.5, Math.hypot(is.wx - cp.x, is.wz - cp.z)));
    _q.setFromAxisAngle(_yAxis, is.rot + t * 0.004);
    _m.compose(_p.set(is.wx, is.wy, is.wz), _q, _s.setScalar(Math.max(is.ws, 0.0001)));
    islandVariants[is.v].mesh.setMatrixAt(is.k, _m);
  }
  for (const iv of islandVariants) iv.mesh.instanceMatrix.needsUpdate = true;
}

// ───────────────────────── thermals (rising air)
const F_TH = 3600, TH_R = 55, TH_H = 720, TH_LIFT = 6.2;
const thermals = [{ x: -110, z: -640 }];
const R2 = rng(5);
while (thermals.length < 7) {
  const x = (R2() - 0.5) * F_TH, z = (R2() - 0.5) * F_TH;
  if (thermals.every((t) => Math.hypot(t.x - x, t.z - z) > 700) && Math.hypot(x, z) > 300) thermals.push({ x, z });
}
const thColGeo = new THREE.CylinderGeometry(TH_R, TH_R * 1.25, TH_H, 40, 1, true);
thColGeo.translate(0, TH_H / 2, 0);
const thColMatBase = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
  uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 } },
  vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform float uTime, uAlpha; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){
      vec3 V = normalize(cameraPosition - vW);
      float f = abs(dot(V, vN));
      float edge = smoothstep(0.0, 0.65, f) * (0.35 + 0.65 * (1.0 - f));
      float s = sin(vUv.x * 6.2831 * 14.0 + sin(vUv.y * 30.0 - uTime * 0.8) * 1.5);
      float streak = smoothstep(0.3, 1.0, s);
      float flow = 0.5 + 0.5 * sin(vUv.y * 70.0 - uTime * 2.4 + vUv.x * 40.0);
      float h = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
      float d = length(cameraPosition - vW);
      float a = (edge * 0.22 + streak * flow * 0.2 * edge) * h * uAlpha * exp(-d * d * 5.5e-7) * smoothstep(10.0, 160.0, d);
      gl_FragColor = vec4(vec3(1.0, 0.86, 0.6), a);
      #include <colorspace_fragment>
    }`,
});
const thermalMeshes = thermals.map(() => {
  const m = new THREE.Mesh(thColGeo, thColMatBase.clone());
  m.frustumCulled = false; m.renderOrder = 6; scene.add(m); return m;
});
// rising motes
const MOTES = isTouch ? 60 : 110;
const moteGeo = new THREE.BufferGeometry();
{
  const n = thermals.length * MOTES, seed = new Float32Array(n * 4), idx = new Float32Array(n);
  const R = rng(9);
  for (let i = 0; i < n; i++) {
    seed[i * 4] = R() * 6.283; seed[i * 4 + 1] = Math.sqrt(R()) * 0.95; seed[i * 4 + 2] = R() * TH_H; seed[i * 4 + 3] = 5 + R() * 6;
    idx[i] = Math.floor(i / MOTES);
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  moteGeo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
}
const thCenters = thermals.map(() => new THREE.Vector3());
const moteMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, toneMapped: false, fog: false,
  uniforms: { uCenters: { value: thCenters }, uTime: { value: 0 }, uScale: { value: 500 } },
  vertexShader: `uniform vec3 uCenters[${thermals.length}]; uniform float uTime, uScale;
    attribute vec4 aSeed; attribute float aIdx; varying float vA;
    void main(){
      vec3 c = uCenters[int(aIdx + 0.5)];
      float y = mod(aSeed.z + uTime * aSeed.w, ${TH_H.toFixed(1)});
      float ang = aSeed.x + uTime * 0.22 + y * 0.008;
      float r = ${TH_R.toFixed(1)} * aSeed.y * (1.0 + y / ${TH_H.toFixed(1)} * 0.25);
      vec4 mv = viewMatrix * vec4(c + vec3(cos(ang) * r, y, sin(ang) * r), 1.0);
      gl_Position = projectionMatrix * mv;
      float d = -mv.z;
      gl_PointSize = clamp(uScale * 1.8 / max(d, 1.0), 1.0, 48.0);
      vA = smoothstep(0.0, 40.0, y) * (1.0 - smoothstep(${(TH_H * 0.6).toFixed(1)}, ${TH_H.toFixed(1)}, y)) * exp(-d * d * 2.2e-6) * smoothstep(2.0, 14.0, d);
    }`,
  fragmentShader: `varying float vA;
    void main(){ float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
      gl_FragColor = vec4(vec3(1.0, 0.93, 0.75), a * vA * 0.85);
      #include <colorspace_fragment>
    }`,
});
const motes = new THREE.Points(moteGeo, moteMat);
motes.frustumCulled = false; motes.renderOrder = 7;
scene.add(motes);

function updateThermals(cp, t) {
  thermals.forEach((th, i) => {
    th.wx = wrap(th.x, cp.x, F_TH); th.wz = wrap(th.z, cp.z, F_TH);
    const edge = 1 - smooth(F_TH * 0.38, F_TH * 0.5, Math.hypot(th.wx - cp.x, th.wz - cp.z));
    const inside = smooth(TH_R * 0.6, TH_R * 2.2, Math.hypot(th.wx - cp.x, th.wz - cp.z));
    const m = thermalMeshes[i];
    m.position.set(th.wx, 0, th.wz);
    m.material.uniforms.uTime.value = t;
    m.material.uniforms.uAlpha.value = edge * (0.45 + 0.55 * inside);
    thCenters[i].set(th.wx, 0, th.wz);
  });
  moteMat.uniforms.uTime.value = t;
}

// ───────────────────────── hang glider model
const metalMat = new THREE.MeshStandardMaterial({ color: '#c9ced8', roughness: 0.35, metalness: 0.75 });
const wireMat = new THREE.MeshStandardMaterial({ color: '#8d929c', roughness: 0.4, metalness: 0.6 });
function tube(a, b, r, mat, r2 = r, seg = 8) {
  const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, seg), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}
function sailPoint(u, v, out = new THREE.Vector3()) {
  const au = Math.abs(u);
  const le = -2.5 + au * 3.6, te = 1.55 - au * 0.45;
  const y = 0.34 * Math.sin(Math.PI * Math.min(1, v * 1.08)) * Math.pow(1 - au, 0.6) - 0.38 * au + 0.12 * (1 - au);
  return out.set(u * 5, y, lerp(le, te, v));
}
const tips = [sailPoint(-1, 0.5), sailPoint(1, 0.5)];
const sailU = { uT: { value: 0 }, uAmt: { value: 0 } };
const sailMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.7, emissive: '#ffffff', emissiveIntensity: 0.3 });
sailMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, sailU);
  sh.vertexShader = 'uniform float uT, uAmt; attribute float aFl;\n' + sh.vertexShader.replace('#include <begin_vertex>',
    `#include <begin_vertex>
     transformed.y += (sin(uT * 31.0 + position.x * 2.7) * 0.022 + sin(uT * 19.0 - position.x * 4.1) * 0.012) * aFl * uAmt;`);
  // fabric lets light through: emissive picks up the sail's own colour
  sh.fragmentShader = sh.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor.rgb;');
};
function buildGlider() {
  const g = new THREE.Group();
  const NU = 40, NV = 10, pos = [], col = [], fl = [], idx = [], tmp = new THREE.Vector3();
  const cA = new THREE.Color('#ff6a4d'), cB = new THREE.Color('#ffb347'), cW = new THREE.Color('#fff4e6'), cL = new THREE.Color('#1d6a85');
  for (let i = 0; i <= NU; i++) {
    const u = (i / NU) * 2 - 1, au = Math.abs(u);
    for (let j = 0; j <= NV; j++) {
      const v = j / NV;
      sailPoint(u, v, tmp); pos.push(tmp.x, tmp.y, tmp.z);
      let c = cA.clone().lerp(cB, au);
      if ((au > 0.42 && au < 0.53) || (au > 0.78 && au < 0.84)) c = cW;
      if (v < 0.12) c = cL;
      col.push(c.r, c.g, c.b);
      fl.push(v * v * (1 - au * 0.3));
    }
  }
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const a = i * (NV + 1) + j, b = a + NV + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  sg.setAttribute('aFl', new THREE.Float32BufferAttribute(fl, 1));
  sg.setIndex(idx); sg.computeVertexNormals();
  const sail = new THREE.Mesh(sg, sailMat);
  g.add(sail);

  // leading edges + battens under the fabric
  const curve = (pts, r) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 3, r, 6);
  const leL = [], leR = [];
  for (let k = 0; k <= 12; k++) {
    const u = k / 12;
    leR.push(sailPoint(u, 0.01).add(new THREE.Vector3(0, -0.035, 0.02)));
    leL.push(sailPoint(-u, 0.01).add(new THREE.Vector3(0, -0.035, 0.02)));
  }
  g.add(new THREE.Mesh(mergeGeometries([curve(leL, 0.045), curve(leR, 0.045)]), metalMat));
  const batt = [];
  for (const u of [-0.72, -0.57, -0.42, -0.27, -0.12, 0.12, 0.27, 0.42, 0.57, 0.72]) {
    const pts = [];
    for (let k = 0; k <= 8; k++) pts.push(sailPoint(u, 0.04 + (k / 8) * 0.9).add(new THREE.Vector3(0, -0.012, 0)));
    batt.push(curve(pts, 0.011));
  }
  g.add(new THREE.Mesh(mergeGeometries(batt), new THREE.MeshStandardMaterial({ color: '#8a3d2c', roughness: 0.8, emissive: '#ff8a5a', emissiveIntensity: 0.15 })));

  // frame
  const nose = new THREE.Vector3(0, 0.08, -2.45), tail = new THREE.Vector3(0, 0.08, 1.7);
  const xl = new THREE.Vector3(-4.2, -0.22, 0.5), xr = new THREE.Vector3(4.2, -0.22, 0.5);
  const hp = new THREE.Vector3(0, 0.05, -0.3), bl = new THREE.Vector3(-0.85, -1.5, -1.3), br = new THREE.Vector3(0.85, -1.5, -1.3);
  g.add(tube(nose, tail, 0.05, metalMat), tube(xl, xr, 0.035, metalMat));
  g.add(tube(hp, bl, 0.032, metalMat), tube(hp, br, 0.032, metalMat), tube(bl, br, 0.038, metalMat));
  for (const e of [bl, br]) for (const t of [nose, tail, e === bl ? xl : xr]) g.add(tube(e, t, 0.0035, wireMat));
  const kingpost = new THREE.Vector3(0, 0.95, 0.1);
  g.add(tube(new THREE.Vector3(0, 0.08, 0.1), kingpost, 0.025, metalMat));
  for (const t of [nose, tail, xl, xr]) g.add(tube(kingpost, t, 0.0035, wireMat));

  // pilot (body hidden in first person; arms + gloves stay)
  const jacket = new THREE.MeshStandardMaterial({ color: '#46679a', roughness: 0.9 });
  const glove = new THREE.MeshStandardMaterial({ color: '#2a2e38', roughness: 0.55 });
  const body = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 1.45, 4, 12).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2b3552', roughness: 0.85 }));
  torso.position.set(0, -1.32, 0.4);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 12), new THREE.MeshStandardMaterial({ color: '#ffd24a', roughness: 0.35 }));
  helmet.position.set(0, -1.2, -0.58);
  body.add(torso, helmet);
  const arms = new THREE.Group();
  const strap = tube(new THREE.Vector3(0, 0.05, -0.1), new THREE.Vector3(0, -1.08, 0.1), 0.02, wireMat);
  body.add(strap);
  g.add(body, arms);
  g.userData = { body, arms, sail };
  return g;
}
const glider = buildGlider();
glider.rotation.order = 'YXZ';
scene.add(glider);

// ───────────────────────── arms: two candidate looks, two-bone IK so posture follows weight shift
const ARM_L1 = 0.56, ARM_L2 = 0.54;
const GRIP = { '-1': new THREE.Vector3(-0.42, -1.5, -1.3), 1: new THREE.Vector3(0.42, -1.5, -1.3) };
const WRIST_OFF = new THREE.Vector3(0, 0.03, 0.088);
const _Y = new THREE.Vector3(0, 1, 0);
// tapered limb along +Y with a slightly flattened cross-section; vertex colours for stripes / glove cuff
function limbGeo(len, prof, base, opts = {}) {
  const { seg = 22, rad = 24, ell = 0.86, stripes = [], cuffFrom = 2, cuffCol = null, wrinkle = 0 } = opts;
  const rAt = (t) => {
    for (let i = 1; i < prof.length; i++) if (t <= prof[i][0]) {
      const [t0, r0] = prof[i - 1], [t1, r1] = prof[i];
      return lerp(r0, r1, smooth(0, 1, (t - t0) / (t1 - t0)));
    }
    return prof[prof.length - 1][1];
  };
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const r = rAt(t) + Math.sin(t * Math.PI * 11) * wrinkle * smooth(0.0, 0.25, t) * (1 - smooth(0.5, 0.8, t));
    for (let j = 0; j <= rad; j++) {
      const a = (j / rad) * Math.PI * 2;
      pos.push(Math.cos(a) * r, t * len, Math.sin(a) * r * ell);
      let c = base;
      for (const st of stripes) if (Math.abs(Math.atan2(Math.sin(a - st.at), Math.cos(a - st.at))) < st.w && t > (st.from ?? 0) && t < (st.to ?? 1)) c = st.col;
      if (t >= cuffFrom && cuffCol) c = cuffCol;
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) {
    const a = i * (rad + 1) + j, b = a + rad + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// overhand grip on the basebar: back of hand on top, fingers curled over the front and under
function buildGlove(sx, gloveMat, padMat) {
  const g = new THREE.Group(), Rf = 0.038 + 0.0125;
  const fingers = [[-0.034, 0.0102], [-0.0115, 0.0118], [0.0115, 0.012], [0.034, 0.011]];
  fingers.forEach(([x, r], k) => {
    const pts = [], reach = 196 - Math.abs(k - 1.5) * 9;
    for (let d = -32; d <= reach; d += 19) {
      const th = (d * Math.PI) / 180;
      pts.push(new THREE.Vector3(x * sx, Math.cos(th) * Rf, -Math.sin(th) * Rf));
    }
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, r, 10), gloveMat));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), gloveMat); tip.position.copy(pts[pts.length - 1]); g.add(tip);
    const kn = new THREE.Mesh(new THREE.SphereGeometry(r * 1.18, 12, 8), padMat);
    kn.position.set(x * sx, Math.cos(-0.5) * Rf + 0.003, -Math.sin(-0.5) * Rf); g.add(kn);
  });
  const back = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18).scale(0.054, 0.021, 0.056), gloveMat);
  back.position.set(0, 0.05, 0.05); back.rotation.x = -0.6; g.add(back);
  const heel = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16).scale(0.047, 0.03, 0.04), gloveMat);
  heel.position.set(-0.004 * sx, 0.045, 0.085); heel.rotation.x = -0.35; g.add(heel);
  const thumb = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.044 * sx, 0.04, 0.07), new THREE.Vector3(-0.056 * sx, 0.006, 0.05),
    new THREE.Vector3(-0.05 * sx, -0.032, 0.026), new THREE.Vector3(-0.034 * sx, -0.05, -0.006)]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(thumb, 20, 0.0125, 10), gloveMat));
  const tt = new THREE.Mesh(new THREE.SphereGeometry(0.0125, 12, 8), gloveMat); tt.position.copy(thumb.getPoint(1)); g.add(tt);
  return g;
}
function buildArms() {
  const sleeve = new THREE.Color('#2f5d8a'), gloveC = new THREE.Color('#1b1d22');
  const limbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: sleeve, roughness: 0.78 });
  const gloveMat = new THREE.MeshStandardMaterial({ color: gloveC, roughness: 0.42 });
  const padMat = new THREE.MeshStandardMaterial({ color: '#30343d', roughness: 0.5 });
  const set = new THREE.Group(), sides = [];
  for (const sx of [-1, 1]) {
    // reflective stripe along the top of the sleeve (the limb frames mirror between the two sides)
    const stripe = { at: 3.3 * sx, w: 0.24, col: new THREE.Color('#ff8a3d'), from: 0.06, to: 0.94 };
    const upperGeo = limbGeo(ARM_L1, [[0, 0.08], [0.3, 0.077], [0.65, 0.068], [1, 0.059]], sleeve, { stripes: [stripe], wrinkle: 0.0028 });
    const foreGeo = limbGeo(ARM_L2, [[0, 0.059], [0.22, 0.061], [0.7, 0.05], [0.83, 0.045], [0.87, 0.057], [1, 0.052]], sleeve,
      { stripes: [{ ...stripe, to: 0.8 }], cuffFrom: 0.85, cuffCol: gloveC, wrinkle: 0.002 });
    const upperF = new THREE.Group(), foreF = new THREE.Group();
    const upper = new THREE.Mesh(upperGeo, limbMat), fore = new THREE.Mesh(foreGeo, limbMat);
    upperF.add(upper); foreF.add(fore);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16), sleeveMat);
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.081, 24, 16), sleeveMat); // closes the open end of the sleeve
    const glove = buildGlove(sx, gloveMat, padMat);
    glove.position.copy(GRIP[sx]);
    set.add(upperF, foreF, elbow, shoulder, glove);
    sides.push({ sx, upperF, foreF, upper, fore, elbow, shoulder });
  }
  set.userData.sides = sides;
  return set;
}
const arms = buildArms();
glider.add(arms);

const _S = new THREE.Vector3(), _W = new THREE.Vector3(), _E = new THREE.Vector3(), _d = new THREE.Vector3(), _pl = new THREE.Vector3();
const _bx = new THREE.Vector3(), _bz = new THREE.Vector3(), _m4 = new THREE.Matrix4();
function frameOn(obj, origin, yAxis, hint) { // y along the bone, x toward the hint direction
  _bx.copy(hint).addScaledVector(yAxis, -hint.dot(yAxis)).normalize();
  _bz.crossVectors(_bx, yAxis);
  _m4.makeBasis(_bx, yAxis, _bz);
  obj.quaternion.setFromRotationMatrix(_m4);
  obj.position.copy(origin);
}
// pilot posture, driven by the controls
const pose = { x: 0, z: 0, turn: 0 };
function updateArms(dt) {
  const p = input.pitch;
  pose.x = damp(pose.x, input.turn * 0.2, 6, dt);
  pose.z = damp(pose.z, p > 0 ? -p * 0.3 : -p * 0.1, 6, dt); // pulling in brings you well forward; pushing out only a little
  pose.turn = damp(pose.turn, input.turn, 6, dt);
  const l1 = ARM_L1, l2 = ARM_L2, reach = (l1 + l2) * 0.95; // the elbow never locks straight
  for (const a of arms.userData.sides) {
    const side = a.sx * pose.turn; // > 0 when leaning toward this arm
    // leaning toward a side: that shoulder comes forward and drops, the other one goes back
    _S.set(0.24 * a.sx + pose.x, -1.4 - 0.06 * side, -0.3 + pose.z - 0.2 * side);
    _W.copy(GRIP[a.sx]).add(WRIST_OFF);
    _d.subVectors(_W, _S);
    let len = _d.length();
    _d.divideScalar(len);
    if (len > reach) { _S.copy(_W).addScaledVector(_d, -reach); len = reach; } // the arm pulls the shoulder along instead
    len = Math.max(len, Math.abs(l1 - l2) + 1e-3);
    const along = (l1 * l1 - l2 * l2 + len * len) / (2 * len), h = Math.sqrt(Math.max(l1 * l1 - along * along, 0));
    const bend = 1 - len / (l1 + l2), toward = Math.max(side, 0);
    _pl.set(a.sx * (1.35 + bend * 1.4 + toward * 0.4), -0.45 - bend * 0.5 - toward * 0.2, 0.35); // bent elbows flare out and down
    _pl.addScaledVector(_d, -_pl.dot(_d)).normalize();
    _E.copy(_S).addScaledVector(_d, along).addScaledVector(_pl, h);
    const up = _bx.subVectors(_E, _S).normalize().clone();
    frameOn(a.upperF, _S, up, _pl);
    const fd = new THREE.Vector3().subVectors(_W, _E).normalize();
    frameOn(a.foreF, _E, fd, _pl);
    a.elbow.position.copy(_E);
    a.shoulder.position.copy(_S);
  }
}

// wingtip vortex trails
const TRAIL_N = 36;
const trails = tips.map(() => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 4), 4));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
  line.frustumCulled = false; scene.add(line);
  return { line, pts: Array.from({ length: TRAIL_N }, () => new THREE.Vector3()), init: false };
});

// speed streaks
const STREAKS = isTouch ? 50 : 90;
const streakGeo = new THREE.BufferGeometry();
streakGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STREAKS * 6), 3));
const streakMat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
const streakLines = new THREE.LineSegments(streakGeo, streakMat);
streakLines.frustumCulled = false; scene.add(streakLines);
const streakP = Array.from({ length: STREAKS }, () => new THREE.Vector3());
let streakInit = false;

// ───────────────────────── state
const P = { pos: new THREE.Vector3(0, 300, 0), heading: 0, speed: 28, vy: 0, gamma: 0, bank: 0, pitchVis: 0, lift: 0, lastThermal: null };
const fwd = new THREE.Vector3(0, 0, -1);
const cam = { az: 2.4, el: 0.2, dist: 12, fov: 64, roll: 0, lookYaw: 2.4, lookPitch: 0, bump: 0, lastLook: -10 };
let state = 'title'; // title | fly | respawn
let respawnT = 0;
const input = { turn: 0, pitch: 0 };

// ───────────────────────── input
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (state === 'title' && (e.code === 'Enter' || e.code === 'Space')) startGame();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
const look = { id: null, lx: 0, ly: 0 };
const joyEl = document.getElementById('joy'), knobEl = document.getElementById('knob');
const canvas = renderer.domElement;
const taps = { down: new Map(), last: -10, x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => {
  if (state === 'title') return;
  const [px, py] = toLocal(e.clientX, e.clientY);
  taps.down.set(e.pointerId, { t: performance.now(), x: px, y: py });
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  if (e.pointerType !== 'mouse' && px < VW * 0.5 && joy.id === null) {
    Object.assign(joy, { id: e.pointerId, ox: px, oy: py, x: 0, y: 0 });
    joyEl.style.left = px + 'px'; joyEl.style.top = py + 'px'; joyEl.classList.add('on');
    knobEl.style.transform = 'translate(-50%,-50%)';
  } else if (look.id === null) {
    Object.assign(look, { id: e.pointerId, lx: px, ly: py });
  }
});
canvas.addEventListener('pointermove', (e) => {
  const [px, py] = toLocal(e.clientX, e.clientY);
  if (e.pointerId === joy.id) {
    const R = 64, dx = px - joy.ox, dy = py - joy.oy, l = Math.hypot(dx, dy), k = l > R ? R / l : 1;
    joy.x = clamp((dx * k) / R, -1, 1); joy.y = clamp((dy * k) / R, -1, 1);
    knobEl.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
  } else if (e.pointerId === look.id) {
    cam.lookYaw -= (px - look.lx) * 0.0065;
    cam.lookPitch = clamp(cam.lookPitch + (py - look.ly) * 0.005, -0.9, 0.55);
    cam.lookYaw = clamp(cam.lookYaw, -1.3, 1.3); // like a real neck: never turn into your own shoulder
    look.lx = px; look.ly = py; cam.lastLook = clock;
  }
});
const release = (e) => {
  const [px, py] = toLocal(e.clientX, e.clientY);
  const d = taps.down.get(e.pointerId);
  taps.down.delete(e.pointerId);
  if (d && tilt.on && e.pointerType !== 'mouse' && performance.now() - d.t < 250 && Math.hypot(px - d.x, py - d.y) < 14) {
    const now = performance.now();
    if (now - taps.last < 350 && Math.hypot(px - taps.x, py - taps.y) < 70) {
      tilt.needZero = true; taps.last = -10;
      showMsg('지금 각도를 수평으로 맞췄어요', 1.6);
      audio.sfx.tick();
    } else Object.assign(taps, { last: now, x: px, y: py });
  }
  if (e.pointerId === joy.id) { joy.id = null; joy.x = joy.y = 0; joyEl.classList.remove('on'); }
  if (e.pointerId === look.id) { look.id = null; cam.lastLook = clock; }
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ───────────────────────── phone tilt steering (turn the phone like a steering wheel)
const tilt = { on: false, seen: false, raw: 0, phi: 0, zero: 0, rel: 0, slow: 0, needZero: true, steady: 0, rawP: 0, phiP: 0, zeroP: 0, relP: 0 };
const wrapPI = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function onOrient(e) {
  if (e.beta == null || e.gamma == null) return;
  const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
  // gravity in device coords (x right, y up), then into screen coords
  const gx = Math.cos(b) * Math.sin(g), gy = -Math.sin(b), gz = -Math.cos(b) * Math.cos(g);
  if (pickSide) { // landscape picked while the browser is upright: which way is the phone turned?
    if (Math.abs(gx) > 0.5) { gameAngle = gx < 0 ? 90 : 270; layout(); }
    pickSide = false;
  }
  const th = ((gameAngle == null ? browserAngle() : gameAngle) * Math.PI) / 180;
  const sx = gx * Math.cos(th) - gy * Math.sin(th), sy = gx * Math.sin(th) + gy * Math.cos(th);
  // how far the screen leans back toward the sky (0 = upright, 90° = flat face up)
  tilt.rawP = Math.atan2(-gz, Math.hypot(sx, sy));
  if (Math.hypot(sx, sy) < 0.35) return; // phone almost flat: wheel angle is undefined
  tilt.raw = Math.atan2(sx, -sy); // clockwise = positive
  tilt.seen = true;
}
function listenTilt() {
  const D = window.DeviceOrientationEvent;
  if (!isTouch || !D) return;
  if (typeof D.requestPermission === 'function') {
    D.requestPermission().then((r) => { if (r === 'granted') addEventListener('deviceorientation', onOrient); }).catch(() => {});
  } else addEventListener('deviceorientation', onOrient);
}
let pickSide = false;
addEventListener('orientationchange', () => setTimeout(layout, 250));
screen.orientation?.addEventListener?.('change', () => setTimeout(layout, 50));
function updateTilt(dt) {
  if (!tilt.seen || state === 'title') return;
  if (!tilt.on) { tilt.on = true; tilt.phi = tilt.raw; tilt.phiP = tilt.rawP; document.body.classList.add('tilt'); }
  const prev = tilt.phi, prevP = tilt.phiP;
  tilt.phi = dampAngle(tilt.phi, tilt.raw, 14, dt);
  tilt.phiP = damp(tilt.phiP, tilt.rawP, 14, dt);
  if (tilt.needZero) { tilt.zero = tilt.phi; tilt.zeroP = tilt.phiP; tilt.slow = 0; tilt.needZero = false; }
  // auto-level: a small tilt (< ~8°) held still for a moment is treated as drift, not a command
  const rate = (Math.abs(wrapPI(tilt.phi - prev)) + Math.abs(tilt.phiP - prevP)) / Math.max(dt, 1e-3);
  tilt.steady = rate < 0.12 ? tilt.steady + dt : 0;
  if (tilt.steady > 1.2) {
    if (Math.abs(wrapPI(tilt.phi - tilt.zero)) < 0.14) tilt.zero = dampAngle(tilt.zero, tilt.phi, 0.35, dt);
    if (Math.abs(tilt.phiP - tilt.zeroP) < 0.14) tilt.zeroP = damp(tilt.zeroP, tilt.phiP, 0.35, dt);
  }
  tilt.rel = wrapPI(tilt.phi - tilt.zero);
  tilt.relP = tilt.phiP - tilt.zeroP; // + = top of the phone tipped away = dive / faster
  // the picture follows the phone's tilt only slowly
  tilt.slow = damp(tilt.slow, tilt.rel, 0.9, dt);
}

function updateInput(dt) {
  const kTurn = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  const kPitch = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const useJoy = joy.id !== null;
  let tTurn = useJoy ? joy.x : kTurn;
  let tPitch = useJoy ? -joy.y : kPitch;
  if (tilt.on) {
    const r = tilt.rel, rp = tilt.relP;
    tTurn = clamp(clamp((Math.abs(r) - 0.05) / 0.4, 0, 1) * Math.sign(r) + (useJoy ? joy.x : 0), -1, 1);
    if (!useJoy) tPitch = clamp((Math.abs(rp) - 0.06) / 0.38, 0, 1) * Math.sign(rp);
  }
  input.turn = damp(input.turn, tTurn, useJoy || tilt.on ? 10 : 3.5, dt);
  input.pitch = damp(input.pitch, tPitch, useJoy ? 10 : tilt.on ? 6 : 3, dt);
}

// ───────────────────────── physics
function nearestThermalLift(p) {
  let best = 0, which = null;
  for (const th of thermals) {
    const d = Math.hypot(p.x - th.wx, p.z - th.wz);
    if (d < TH_R) { const l = TH_LIFT * (1 - (d / TH_R) ** 2); if (l > best) { best = l; which = th; } }
  }
  return { lift: best * (1 - smooth(540, 720, p.y)), which };
}

function updatePhysics(dt) {
  // the nose follows the control (forward = dive ~32°, back = climb ~27°);
  // speed then comes from gravity along that path, so diving speeds you up and climbing bleeds speed
  let gT = input.pitch >= 0 ? -input.pitch * 0.56 : -input.pitch * 0.48;
  if (P.speed < 18) gT = Math.min(gT, lerp(-0.25, 0, (P.speed - 13) / 5)); // too slow: nose drops gently
  P.gamma = damp(P.gamma, gT, 2.2, dt);
  P.speed = Math.max(13, P.speed + (-9.8 * Math.sin(P.gamma) - (P.speed - 28) * 0.22) * dt);
  const sink = (1.3 + 0.0018 * (P.speed - 22) ** 2) / Math.max(Math.cos(P.bank), 0.5);
  const th = nearestThermalLift(P.pos);
  if (th.which) P.lastThermal = th.which;
  P.lift = damp(P.lift, th.lift, 2.5, dt);
  P.vy = damp(P.vy, P.speed * Math.sin(P.gamma) - sink * Math.cos(P.gamma) + P.lift, 4, dt);
  P.bank = damp(P.bank, input.turn * 0.9, 2.2, dt);
  P.heading -= ((9.8 * Math.tan(P.bank)) / P.speed) * 1.15 * dt;
  fwd.set(-Math.sin(P.heading), 0, -Math.cos(P.heading));
  P.pos.addScaledVector(fwd, P.speed * Math.cos(P.gamma) * dt);
  P.pos.y += P.vy * dt;
  P.pitchVis = damp(P.pitchVis, P.gamma + Math.atan2(-sink, P.speed) * 0.5, 5, dt);

  // islands: soft bump, never a game over
  for (const is of islands) {
    const s = is.ws, iv = islandVariants[is.v];
    if (s < 0.05) continue;
    const top = is.wy + iv.top * s, bottom = is.wy - iv.h * s;
    if (P.pos.y > top + 3 || P.pos.y < bottom) continue;
    const dx = P.pos.x - is.wx, dz = P.pos.z - is.wz, d = Math.hypot(dx, dz);
    const f = clamp((top - P.pos.y) / (iv.h * s), 0, 1);
    const rAt = iv.r * s * (1 - f * 0.85) + 3;
    if (d < rAt) {
      if (P.pos.y > top - 5) { P.pos.y = top + 3; P.vy = Math.max(P.vy, 4); }
      else { const k = rAt / Math.max(d, 0.01); P.pos.x = is.wx + dx * k; P.pos.z = is.wz + dz * k; }
      P.speed = Math.max(18, P.speed * 0.6);
      bump();
    }
  }
  if (P.pos.y < 34) beginRespawn();
}

let bumpCool = 0;
const audio = createAudio();
function bump() {
  if (bumpCool > 0) return;
  bumpCool = 0.5; cam.bump = 1;
  audio.sfx.bump();
  flashEl.style.transition = 'none'; flashEl.style.opacity = '0.35';
  requestAnimationFrame(() => { flashEl.style.transition = 'opacity .6s'; flashEl.style.opacity = '0'; });
}

function beginRespawn() {
  if (state !== 'fly') return;
  state = 'respawn'; respawnT = 0;
  audio.sfx.fall();
}
function updateRespawn(dt) {
  respawnT += dt;
  whiteEl.style.opacity = String(clamp(respawnT / 0.6, 0, 1));
  if (respawnT > 0.7 && respawnT - dt <= 0.7) {
    const th = P.lastThermal;
    if (th) { P.pos.set(th.wx + 90, 300, th.wz); P.heading = 0; }
    else P.pos.y = 300;
    P.speed = 28; P.vy = 0; P.gamma = 0; P.pitchVis = 0; P.bank = 0; P.lift = 0;
    fwd.set(-Math.sin(P.heading), 0, -Math.cos(P.heading));
    cam.az = P.heading; trails.forEach((t) => (t.init = false)); streakInit = false;
    showMsg('구름바다에서 다시 떠올랐어요');
    audio.sfx.respawn();
  }
  if (respawnT > 0.7) whiteEl.style.opacity = String(1 - clamp((respawnT - 0.9) / 1.0, 0, 1));
  if (respawnT > 1.9) { state = 'fly'; whiteEl.style.opacity = '0'; }
}

// ───────────────────────── camera (third person for the title, first person in flight)
const _v = new THREE.Vector3(), _t = new THREE.Vector3();
const tpPos = new THREE.Vector3(), tpQuat = new THREE.Quaternion(), fpPos = new THREE.Vector3(), fpQuat = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const EYE = new THREE.Vector3(0, -1.2, -0.45);
const view = { blend: 0, shift: new THREE.Vector2() };
function updateCamera(dt, t) {
  const looking = look.id !== null;
  if (state === 'title') {
    cam.lookYaw = 2.3 + Math.sin(t * 0.12) * 0.5;
    cam.lookPitch = 0.05;
  } else if (!looking && t - cam.lastLook > 0.8) {
    cam.lookYaw = dampAngle(cam.lookYaw, 0, 1.6, dt);
    cam.lookPitch = damp(cam.lookPitch, 0, 1.6, dt);
  }
  const portrait = camera.aspect < 1;
  view.blend = damp(view.blend, state !== 'title' ? 1 : 0, 2.4, dt);
  const b = view.blend;

  // third person
  const lookAmt = clamp(Math.abs(cam.lookYaw) / 1.2 + Math.max(cam.lookPitch, 0) * 0.5, 0, 1);
  cam.az = dampAngle(cam.az, P.heading + cam.lookYaw, looking ? 14 : 3.2, dt);
  cam.el = damp(cam.el, 0.19 + Math.max(cam.lookPitch, -0.32) + clamp(-P.vy * 0.006, -0.08, 0.12), 3, dt);
  cam.dist = damp(cam.dist, (11.5 + (P.speed - 28) * 0.1) * (portrait ? 1.3 : 1), 2, dt);
  const ce = Math.cos(cam.el);
  camera.position.set(P.pos.x + Math.sin(cam.az) * ce * cam.dist, P.pos.y + Math.sin(cam.el) * cam.dist, P.pos.z + Math.cos(cam.az) * ce * cam.dist);
  _t.copy(P.pos).addScaledVector(fwd, 14 * (1 - lookAmt)).y += 1.4;
  camera.up.set(0, 1, 0);
  camera.lookAt(_t);
  cam.roll = damp(cam.roll, -P.bank * 0.42 * (1 - lookAmt), 4, dt);
  camera.rotateZ(cam.roll);
  if (state === 'title') camera.rotateX(camera.aspect < 1 ? 0.42 : 0.2); // keep the glider out from behind the title panel
  tpPos.copy(camera.position); tpQuat.copy(camera.quaternion);

  // first person: pilot's eyes, body sways with weight shift
  view.shift.x = damp(view.shift.x, input.turn * 0.2, 5, dt);
  view.shift.y = damp(view.shift.y, -input.pitch * 0.15, 5, dt);
  fpPos.set(EYE.x + view.shift.x, EYE.y, EYE.z + view.shift.y).applyMatrix4(glider.matrixWorld);
  const sway = 0.003 + smooth(36, 56, P.speed) * 0.004;
  _e.set(
    P.pitchVis * 0.95 + 0.07 - cam.lookPitch + (vnoise(t * 0.7, 3.1) - 0.5) * sway * 4,
    P.heading + cam.lookYaw + (vnoise(t * 0.5, 7.7) - 0.5) * sway * 4,
    -P.bank * 0.82
  );
  fpQuat.setFromEuler(_e);

  camera.position.lerpVectors(tpPos, fpPos, b);
  camera.quaternion.slerpQuaternions(tpQuat, fpQuat, b);
  // counter-rotate by the part of the phone's tilt the picture hasn't caught up with yet,
  // so a fresh tilt looks level and the view leans in gradually
  if (tilt.on) camera.rotateZ(-(tilt.rel - tilt.slow));
  // speed buffet + bump shake
  cam.bump = damp(cam.bump, 0, 3, dt);
  const amp = smooth(40, 56, P.speed) * (0.0035 + b * 0.002) + cam.bump * 0.03;
  camera.rotateX((vnoise(t * 13, 1.7) - 0.5) * 2 * amp);
  camera.rotateY((vnoise(t * 11, 8.3) - 0.5) * 2 * amp);

  const sp = clamp((P.speed - 16) / 40, 0, 1);
  cam.fov = damp(cam.fov, lerp(lerp(60, 84, sp), lerp(78, 94, sp), b), 2.5, dt);
  const hHalf = ((portrait ? lerp(27, 36, b) : 0) * Math.PI) / 180;
  camera.fov = portrait ? (2 * Math.atan(Math.tan(hHalf) / camera.aspect) * 180) / Math.PI + (cam.fov - lerp(60, 78, b)) * 0.5 : cam.fov;
  camera.near = b > 0.5 ? 0.08 : 0.5;
  camera.updateProjectionMatrix();
  // hide the pilot's body when we're inside it
  glider.userData.body.visible = b < 0.6;
}

// ───────────────────────── fx
function updateGlider(dt, t) {
  glider.position.copy(P.pos);
  if (state === 'title') glider.position.y += Math.sin(t * 0.8) * 0.4;
  glider.rotation.set(P.pitchVis, P.heading, -P.bank);
  const body = glider.userData.body;
  body.position.x = damp(body.position.x, input.turn * 0.32, 6, dt);
  body.position.z = damp(body.position.z, -input.pitch * 0.24, 6, dt);
  updateArms(dt);
  glider.updateMatrixWorld();
  sailU.uT.value = t;
  sailU.uAmt.value = 0.35 + smooth(20, 56, P.speed) * 1.4;
  // translucency: more glow when the sun is above the sail
  _v.set(0, 1, 0).applyQuaternion(glider.quaternion);
  sailMat.emissiveIntensity = 0.22 + Math.max(_v.dot(SUN), 0) * 0.55;
}

function updateTrails() {
  const k = Math.max(smooth(0.35, 0.85, Math.abs(P.bank)), smooth(36, 54, P.speed), smooth(1.5, 5, P.lift) * 0.5);
  trails.forEach((tr, i) => {
    const wp = _v.copy(tips[i]).applyMatrix4(glider.matrixWorld);
    if (!tr.init) { tr.pts.forEach((p) => p.copy(wp)); tr.init = true; }
    for (let j = TRAIL_N - 1; j > 0; j--) tr.pts[j].copy(tr.pts[j - 1]);
    tr.pts[0].copy(wp);
    const pa = tr.line.geometry.attributes.position.array, ca = tr.line.geometry.attributes.color.array;
    for (let j = 0; j < TRAIL_N; j++) {
      pa[j * 3] = tr.pts[j].x; pa[j * 3 + 1] = tr.pts[j].y; pa[j * 3 + 2] = tr.pts[j].z;
      const a = (1 - j / TRAIL_N) * k * 0.55;
      ca[j * 4] = 1; ca[j * 4 + 1] = 1; ca[j * 4 + 2] = 1; ca[j * 4 + 3] = a;
    }
    tr.line.geometry.attributes.position.needsUpdate = true;
    tr.line.geometry.attributes.color.needsUpdate = true;
  });
}

function updateStreaks() {
  const k = smooth(34, 54, P.speed);
  streakMat.opacity = k * 0.32;
  streakLines.visible = k > 0.01;
  if (!streakLines.visible) return;
  const c = camera.position, B = { x: 22, y: 14, z: 30 };
  if (!streakInit) { streakP.forEach((p) => p.set(c.x + (Math.random() - 0.5) * 2 * B.x, c.y + (Math.random() - 0.5) * 2 * B.y, c.z + (Math.random() - 0.5) * 2 * B.z)); streakInit = true; }
  const vel = _v.copy(fwd).multiplyScalar(P.speed); vel.y = P.vy;
  const len = 0.06 + P.speed * 0.0035;
  const a = streakGeo.attributes.position.array;
  streakP.forEach((p, i) => {
    p.x = wrap(p.x, c.x, B.x * 2); p.y = wrap(p.y, c.y, B.y * 2); p.z = wrap(p.z, c.z, B.z * 2);
    const near = p.distanceTo(c);
    const s = near < 3 ? 0 : len;
    a[i * 6] = p.x; a[i * 6 + 1] = p.y; a[i * 6 + 2] = p.z;
    a[i * 6 + 3] = p.x - vel.x * s; a[i * 6 + 4] = p.y - vel.y * s; a[i * 6 + 5] = p.z - vel.z * s;
  });
  streakGeo.attributes.position.needsUpdate = true;
}

function cloudInside(cp) {
  let w = 0;
  for (const c of clusters) {
    const x = wrap(c.x, cp.x, c.F), z = wrap(c.z, cp.z, c.F);
    const d = Math.hypot((cp.x - x) / c.r, (cp.y - c.y) / (c.r * 0.55), (cp.z - z) / c.r);
    w = Math.max(w, 1 - smooth(0.35, 1.05, d));
  }
  return w;
}

// ───────────────────────── HUD / UI
const $ = (id) => document.getElementById(id);
const altEl = $('alt'), spdEl = $('spd'), varEl = $('vario'), varBox = $('variobox');
const msgEl = $('msg'), whiteEl = $('white'), flashEl = $('flash'), cfogEl = $('cloudfog'), hintEl = $('hint');
let msgTimer = 0;
function showMsg(s, d = 2.6) { msgEl.textContent = s; msgEl.classList.add('on'); msgTimer = d; }
let hudT = 0, varioS = 0;
function updateHUD(dt) {
  varioS = damp(varioS, P.vy, 3, dt);
  hudT -= dt;
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) msgEl.classList.remove('on'); }
  if (hudT > 0) return;
  hudT = 0.1;
  altEl.textContent = Math.round(P.pos.y);
  spdEl.textContent = Math.round(P.speed * 3.6);
  const up = varioS >= 0;
  varEl.textContent = (up ? '▲ ' : '▼ ') + Math.abs(varioS).toFixed(1);
  varBox.className = 'stat vario ' + (P.lift > 1.5 ? 'thermal' : up ? 'up' : 'down');
}

document.body.classList.add(isTouch ? 'touch' : 'desk');
let playMode = null; // 'portrait' | 'landscape' on phones
function goFullscreen(mode) {
  const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return false;
  try {
    const lock = () => { try { screen.orientation?.lock?.(mode)?.catch?.(() => {}); } catch (_) {} };
    const pr = req.call(el, { navigationUI: 'hide' });
    if (pr && pr.then) pr.then(lock).catch(() => {}); else lock();
    return true;
  } catch (_) { return false; }
}
function startGame(mode) {
  if (state !== 'title') return;
  audio.start(); // must happen inside the tap/click
  if (isTouch && (mode === 'portrait' || mode === 'landscape')) {
    playMode = mode;
    const ba = browserAngle();
    if (mode === 'portrait') gameAngle = 0;
    else if (ba === 90 || ba === 270) gameAngle = ba;
    else { gameAngle = 90; pickSide = true; }
    layout();
    const fs = goFullscreen(mode);
    if (!fs && !navigator.standalone && /iPhone|iPod/.test(navigator.userAgent))
      setTimeout(() => showMsg('아이폰은 공유 → 홈 화면에 추가로 열면 전체화면이 돼요', 5), 7500);
  }
  state = 'fly';
  document.body.classList.add('flying');
  $('title').classList.add('off');
  listenTilt();
  tilt.needZero = true;
  setTimeout(() => hintEl.classList.add('on'), 1200);
  setTimeout(() => hintEl.classList.remove('on'), 10000);
  setTimeout(() => showMsg('빛나는 바람 기둥 안을 빙글빙글 돌면 높이 올라가요', 4.5), 2500);
  if (vol) showMsg('구름 후보 ' + CLOUD_PRESET + ': ' + vol.preset.name, 2.4);
}
$('startBtn').addEventListener('click', () => startGame());
const sndBtn = $('sndBtn');
const showSnd = () => { sndBtn.textContent = audio.muted ? '🔇' : '🔊'; };
showSnd();
sndBtn.addEventListener('click', () => { audio.setMuted(!audio.muted); if (!audio.muted) audio.start(); showSnd(); });
document.querySelectorAll('.modeBtn').forEach((b) => b.addEventListener('click', () => startGame(b.dataset.mode)));
if (!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)) $('fs').style.display = 'none';
$('fs').addEventListener('click', () => {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  } catch (_) {}
});

addEventListener('resize', () => {
  layout();
  setTimeout(layout, 300);
});

// ───────────────────────── loop
let last = performance.now(), clock = 0, frameAvg = 1 / 60, prTimer = 0;
document.addEventListener('visibilitychange', () => { last = performance.now(); });
function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000; last = now;
  const dt = Math.min(0.05, raw);
  clock += dt;
  bumpCool -= dt;

  updateTilt(dt);
  updateInput(dt);
  if (state === 'fly') updatePhysics(dt);
  else if (state === 'respawn') updateRespawn(dt);
  else { // title: cruise straight, hold altitude
    fwd.set(-Math.sin(P.heading), 0, -Math.cos(P.heading));
    P.pos.addScaledVector(fwd, P.speed * 0.6 * dt);
  }

  const cp = P.pos;
  updateIslands(cp, clock);
  updateThermals(cp, clock);
  updateGlider(dt, clock);
  updateCamera(dt, clock);
  if (vol) vol.update(dt); else updateClouds(camera.position);
  updateTrails();
  updateStreaks();

  sky.position.copy(camera.position);
  sea.position.set(Math.round(camera.position.x / SEA_TILE) * SEA_TILE, SEA_Y, Math.round(camera.position.z / SEA_TILE) * SEA_TILE);
  moteMat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
  const cloudAmt = vol ? vol.insideAt(camera.position) : cloudInside(camera.position);
  if (!vol) cfogEl.style.opacity = (cloudAmt * 0.85).toFixed(3); // volumetric clouds draw their own inside view
  audio.update({ speed: P.speed, vy: P.vy, lift: P.lift, bank: P.bank, cloud: cloudAmt, flying: state === 'fly' });
  updateHUD(dt);

  composer.render(dt);

  // adaptive resolution: keep it smooth on phones
  frameAvg = lerp(frameAvg, raw, 0.05);
  prTimer += raw;
  if (prTimer > 2) {
    prTimer = 0;
    const max = Math.min(devicePixelRatio || 1, Q.pr);
    if (frameAvg > 1 / 42 && pixelRatio <= 0.7 && bloom.enabled) bloom.enabled = false;
    else if (frameAvg > 1 / 42 && pixelRatio > 0.7) pixelRatio = Math.max(0.7, pixelRatio - 0.15);
    else if (frameAvg < 1 / 57 && pixelRatio < max) pixelRatio = Math.min(max, pixelRatio + 0.1);
    else return;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(VW, VH);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(VW, VH);
  }
}
window.__game = { P, input, keys, view, tilt, cam, get state() { return state; }, startGame };
requestAnimationFrame(frame);
