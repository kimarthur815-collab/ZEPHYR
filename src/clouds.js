// Volumetric (ray-marched) clouds: a sea of clouds below and cumulus towers above.
// Rendered as a post pass between the scene render and bloom, at reduced resolution.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// three looks, each modelled on a kind of photo
export const CLOUD_PRESETS = {
  1: { // 노을 운해: sunset sea of clouds seen from a plane window / a mountain top
    name: '노을 운해',
    sea: [-70, 45, 40, 0.8], cu: [210, 430, 0.5, 0.1], shape: [520, 1100, 150, 0.55],
    light: [0.095, 0.14, 0.6, 0.55],
    sunCol: [3.9, 2.35, 1.2], ambTop: [0.34, 0.38, 0.62], ambBot: [0.56, 0.38, 0.46], floor: '#7d6f98',
  },
  2: { // 뭉게구름: towering cumulus rising out of a broken cloud sea
    name: '뭉게구름',
    sea: [-70, 25, 38, 0.62], cu: [170, 680, 0.9, 0.08], shape: [560, 1200, 170, 0.55],
    light: [0.11, 0.09, 0.62, 0.5],
    sunCol: [5.6, 3.9, 2.4], ambTop: [0.42, 0.5, 0.76], ambBot: [0.3, 0.27, 0.38], floor: '#6f6f96',
  },
  3: { // 몽환 파스텔: soft cotton-candy clouds in pink and lavender
    name: '몽환 파스텔',
    sea: [-70, 40, 36, 0.78], cu: [200, 470, 0.7, 0.12], shape: [640, 1200, 220, 0.32],
    light: [0.06, 0.22, 0.45, 0.6],
    sunCol: [2.9, 1.7, 1.75], ambTop: [0.52, 0.42, 0.66], ambBot: [0.74, 0.46, 0.6], floor: '#a48aae',
  },
};

const WEATHER_TILE = 7000;

// ── tileable 3D Perlin-Worley noise, generated on the GPU one slice at a time
function makeNoise3D(renderer, N) {
  const rt = new THREE.WebGL3DRenderTarget(N, N, N, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false });
  const tex = rt.texture;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const quad = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { uZ: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `
      uniform float uZ; varying vec2 vUv;
      vec3 hash33(vec3 p){ p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
      float worley(vec3 p, float f){
        vec3 id = floor(p * f), fp = fract(p * f); float m = 1e9;
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
          vec3 o = vec3(x, y, z), d = o + hash33(mod(id + o, vec3(f))) - fp; m = min(m, dot(d, d));
        }
        return 1. - sqrt(m);
      }
      float grad(vec3 x, float f){
        vec3 p = floor(x * f), w = fract(x * f), u = w * w * w * (w * (w * 6. - 15.) + 10.);
        #define G(o) dot(hash33(mod(p + o, vec3(f))) * 2. - 1., w - o)
        return mix(mix(mix(G(vec3(0,0,0)), G(vec3(1,0,0)), u.x), mix(G(vec3(0,1,0)), G(vec3(1,1,0)), u.x), u.y),
                   mix(mix(G(vec3(0,0,1)), G(vec3(1,0,1)), u.x), mix(G(vec3(0,1,1)), G(vec3(1,1,1)), u.x), u.y), u.z);
      }
      float pfbm(vec3 p, float f){ float a = 1., n = 0.; for (int i = 0; i < 5; i++){ n += a * grad(p, f); f *= 2.; a *= .55; } return n; }
      float wfbm(vec3 p, float f){ return worley(p, f) * .625 + worley(p, f * 2.) * .25 + worley(p, f * 4.) * .125; }
      void main(){
        vec3 p = vec3(vUv, uZ);
        float g = wfbm(p, 3.), b = wfbm(p, 6.), a = wfbm(p, 12.);
        float pn = abs(mix(1., pfbm(p, 3.), .5) * 2. - 1.);           // billowy perlin
        float r = g + (pn - 0.) * (1. - g);                            // perlin-worley: remap(pn, 0, 1, g, 1)
        gl_FragColor = vec4(r, g, b, a);
      }`,
  }));
  const prev = renderer.getRenderTarget();
  for (let z = 0; z < N; z++) {
    quad.material.uniforms.uZ.value = (z + 0.5) / N;
    renderer.setRenderTarget(rt, z);
    quad.render(renderer);
  }
  renderer.setRenderTarget(prev);
  quad.dispose();
  return tex;
}

// ── 2D weather map: R = cumulus coverage, G = cloud-sea top height, B = cloud-sea density
function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y, P) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const w = (i, j) => hash2((((xi + i) % P) + P) % P, (((yi + j) % P) + P) % P);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (w(0, 0) * (1 - u) + w(1, 0) * u) * (1 - v) + (w(0, 1) * (1 - u) + w(1, 1) * u) * v;
}
function fbm(x, y, P, oct, seed) {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f + seed, y * f + seed * 1.7, P * f); n += a; a *= 0.5; f *= 2; }
  return s / n;
}
function makeWeather() {
  const S = 256, data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = i / S, v = j / S, k = (j * S + i) * 4;
    data[k] = fbm(u * 5, v * 5, 5, 4, 0) * 255;
    data[k + 1] = fbm(u * 7, v * 7, 7, 4, 11) * 255;
    data[k + 2] = fbm(u * 9, v * 9, 9, 3, 23) * 255;
    data[k + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, S, S);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { tex, data, S };
}

const MARCH_FRAG = `
precision highp sampler3D;
uniform sampler2D tDepth, tWeather; uniform sampler3D tNoise;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 uCamPos, uSun, uSunCol, uAmbTop, uAmbBot, uFogCol, uGlowCol;
uniform float uTime, uFogDensity, uSteps, uLightSteps, uMaxDist;
uniform vec4 uSea, uCu, uShape, uLight;
varying vec2 vUv;
vec3 WIND;
float remap(float v, float l0, float h0, float l1, float h1){ return l1 + (v - l0) * (h1 - l1) / (h0 - l0); }
float hg(float c, float g){ float g2 = g * g; return (1. - g2) / pow(1. + g2 - 2. * g * c, 1.5); }
float density(vec3 p, bool fine, out float hfrac){
  vec4 w = texture(tWeather, (p.xz + WIND.xz) * ${(1 / WEATHER_TILE).toFixed(8)});
  float d = 0.; hfrac = 0.;
  float seaTop = uSea.y + (w.g - .5) * 2. * uSea.z;
  if (p.y > uSea.x && p.y < seaTop) {
    float h = (p.y - uSea.x) / (seaTop - uSea.x); hfrac = h;
    float gr = smoothstep(0., .2, h) * (1. - smoothstep(.25, 1., h));
    vec4 n = texture(tNoise, (p + WIND) / uShape.x);
    float base = remap(n.r, n.g * .625 + n.b * .25 + n.a * .125 - 1., 1., 0., 1.);
    float cov = clamp(uSea.w * mix(.8, 1.12, w.b), 0., 1.);
    d = clamp(remap(base * gr, 1. - cov, 1., 0., 1.), 0., 1.);
  } else if (p.y > uCu.x && p.y < uCu.y) {
    float cov = smoothstep(.38 - uCu.w, .72 - uCu.w, w.r) * uCu.z;
    if (cov > .02) {
      float h = (p.y - uCu.x) / (uCu.y - uCu.x); hfrac = h;
      float gr = smoothstep(0., .06, h) * (1. - smoothstep(.15 + .75 * cov, 1., h));
      vec4 n = texture(tNoise, (p + WIND) / uShape.y);
      float base = remap(n.r, n.g * .625 + n.b * .25 + n.a * .125 - 1., 1., 0., 1.);
      d = clamp(remap(base * gr, 1. - cov, 1., 0., 1.), 0., 1.) * sqrt(cov);
    }
  }
  if (fine && d > 0.) {
    vec4 n2 = texture(tNoise, (p + WIND * 1.8) / uShape.z);
    float hf = n2.g * .625 + n2.b * .25 + n2.a * .125;
    hf = mix(1. - hf, hf, clamp(hfrac * 3., 0., 1.)); // wispy underneath, billowy on top
    d = clamp(remap(d, hf * uShape.w, 1., 0., 1.), 0., 1.);
  }
  return d;
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }
void main(){
  WIND = vec3(uTime * 3.5, 0., uTime * 1.3);
  float depth = texture(tDepth, vUv).x;
  vec4 vp = uProjInv * vec4(vUv * 2. - 1., depth * 2. - 1., 1.); vp.xyz /= vp.w;
  float sceneDist = depth >= .999999 ? 1e9 : length(vp.xyz);
  vec3 rd = normalize(mat3(uCamWorld) * normalize(vp.xyz)), ro = uCamPos;
  float t0 = 0., t1 = uMaxDist, lo = uSea.x, hi = uCu.y;
  if (abs(rd.y) > 1e-5) { float ta = (lo - ro.y) / rd.y, tb = (hi - ro.y) / rd.y; t0 = max(0., min(ta, tb)); t1 = min(t1, max(ta, tb)); }
  else if (ro.y < lo || ro.y > hi) t1 = -1.;
  t1 = min(t1, sceneDist);
  if (t1 <= t0) { gl_FragColor = vec4(0., 0., 0., 1.); return; }
  float cosT = dot(rd, uSun);
  float phase = mix(hg(cosT, uLight.z), hg(cosT, -.2), .3);
  float seaTopMax = uSea.y + uSea.z;
  float T = 1., wsum = 0., dsum = 0.; vec3 S = vec3(0.);
  float t = t0 + ign(gl_FragCoord.xy) * 6.;
  float hfrac;
  for (int i = 0; i < 200; i++) {
    if (float(i) >= uSteps || t >= t1 || T < .02) break;
    vec3 p = ro + rd * t;
    if (p.y > seaTopMax && p.y < uCu.x) { // empty gap between the two layers
      float tn = rd.y > 0. ? (uCu.x - ro.y) / rd.y : (seaTopMax - ro.y) / rd.y;
      t = max(t + 2., tn + .5); continue;
    }
    float dt = clamp(t * .016, 4., 60.);
    float d = density(p, true, hfrac);
    if (d > .004) {
      float od = 0., ls = 8., hl; vec3 lp = p;
      for (int j = 0; j < 8; j++) { if (float(j) >= uLightSteps) break; lp += uSun * ls; od += density(lp, false, hl) * ls; ls *= 1.9; }
      float ext = uLight.x;
      // sunlight reaching this point: blue is absorbed a little faster, so light that went through cloud turns warm
      vec3 sun = exp(-od * ext * vec3(.82, 1., 1.25)) + uLight.y * exp(-od * ext * .22 * vec3(.85, 1., 1.2));
      // "powder": thin edges seen with the sun behind you look darker
      float pw = mix(1., 1. - exp(-d * ext * 45.), .6 * clamp(.5 - .5 * cosT, 0., 1.));
      vec3 L = uSunCol * sun * phase * pw + mix(uAmbBot, uAmbTop, hfrac) * uLight.w;
      float Ts = exp(-d * ext * dt);
      float wgt = T * (1. - Ts);
      S += wgt * L; wsum += wgt; dsum += wgt * t;
      T *= Ts;
    } else dt *= 1.8;
    t += dt;
  }
  if (wsum > 0.) { // fade into the same glowing haze as the rest of the scene
    float dist = dsum / wsum, f = 1. - exp(-uFogDensity * uFogDensity * dist * dist), fs = max(cosT, 0.);
    vec3 fog = uFogCol + uGlowCol * (pow(fs, 6.) * .45 + pow(fs, 40.) * .55);
    S = mix(S, fog * (1. - T), f);
  }
  gl_FragColor = vec4(S, T);
}`;

class CloudPass extends Pass {
  constructor(camera, mat, scale) {
    super();
    this.camera = camera; this.scale = scale; this.needsSwap = true;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rt.texture.minFilter = this.rt.texture.magFilter = THREE.LinearFilter;
    this.march = new FullScreenQuad(mat);
    this.comp = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tClouds: { value: null }, tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uLow: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: `uniform sampler2D tScene, tClouds, tDepth; uniform mat4 uProjInv; uniform vec2 uLow; varying vec2 vUv;
        float distAt(vec2 uv){
          float d = texture2D(tDepth, uv).x;
          if (d >= 1.) return 1e6;
          vec4 vp = uProjInv * vec4(uv * 2. - 1., d * 2. - 1., 1.);
          return length(vp.xyz / vp.w);
        }
        void main(){
          vec4 s = texture2D(tScene, vUv);
          float z = distAt(vUv);
          // the clouds are rendered at low resolution: keep them off nearby things (the glider, your arms)
          // so their edges stay crisp; a few metres of cloud in front of them would be invisible anyway
          if (z < 20.) { gl_FragColor = vec4(s.rgb, 1.); return; }
          // depth-aware upsampling: blend the 4 nearest low-res cloud texels, favouring the ones that saw
          // the same surface as this pixel, so island edges get no halo or stair-steps
          vec2 lp = vUv * uLow - .5, b = floor(lp), f = lp - b;
          vec4 acc = vec4(0.); float ws = 0.;
          for (int i = 0; i < 4; i++) {
            vec2 o = vec2(float(i - (i / 2) * 2), float(i / 2));
            vec2 uv = (b + o + .5) / uLow;
            float wb = (o.x > .5 ? f.x : 1. - f.x) * (o.y > .5 ? f.y : 1. - f.y);
            float wd = 1. / (.002 + abs(distAt(uv) - z) / max(z, 1.));
            acc += texture2D(tClouds, uv) * (wb * wd + 1e-5); ws += wb * wd + 1e-5;
          }
          vec4 c = acc / ws;
          gl_FragColor = vec4(s.rgb * c.a + c.rgb, 1.);
        }`,
      depthTest: false, depthWrite: false,
    }));
  }
  setSize(w, h) { this.rt.setSize(Math.max(1, Math.round(w * this.scale)), Math.max(1, Math.round(h * this.scale))); }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.march.material.uniforms, c = this.camera;
    u.tDepth.value = readBuffer.depthTexture;
    u.uProjInv.value.copy(c.projectionMatrixInverse);
    u.uCamWorld.value.copy(c.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(c.matrixWorld);
    renderer.setRenderTarget(this.rt);
    this.march.render(renderer);
    this.comp.material.uniforms.tScene.value = readBuffer.texture;
    this.comp.material.uniforms.tDepth.value = readBuffer.depthTexture;
    this.comp.material.uniforms.uProjInv.value.copy(c.projectionMatrixInverse);
    this.comp.material.uniforms.uLow.value.set(this.rt.width, this.rt.height);
    this.comp.material.uniforms.tClouds.value = this.rt.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.comp.render(renderer);
  }
}

export function createVolumetricClouds(renderer, camera, presetId, { mobile, sun, fogColor, glowColor, fogDensity }) {
  const P = CLOUD_PRESETS[presetId];
  const weather = makeWeather();
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tDepth: { value: null }, tWeather: { value: weather.tex }, tNoise: { value: makeNoise3D(renderer, 64) },
      uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uSun: { value: sun.clone() }, uSunCol: { value: v3(P.sunCol) }, uAmbTop: { value: v3(P.ambTop) }, uAmbBot: { value: v3(P.ambBot) },
      uFogCol: { value: fogColor.clone() }, uGlowCol: { value: glowColor.clone() }, uFogDensity: { value: fogDensity * 0.6 },
      uTime: { value: 0 }, uSteps: { value: mobile ? 56 : 110 }, uLightSteps: { value: mobile ? 4 : 6 }, uMaxDist: { value: 3600 },
      uSea: { value: new THREE.Vector4(...P.sea) }, uCu: { value: new THREE.Vector4(...P.cu) },
      uShape: { value: new THREE.Vector4(...P.shape) }, uLight: { value: new THREE.Vector4(...P.light) },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: MARCH_FRAG,
    depthTest: false, depthWrite: false,
  });
  const pass = new CloudPass(camera, mat, mobile ? 0.36 : 0.75);

  // rough CPU copy of the density, for "are we inside a cloud" (sound cue)
  const wAt = (x, z, ch) => {
    const S = weather.S, u = (((x / WEATHER_TILE) % 1) + 1) % 1, v = (((z / WEATHER_TILE) % 1) + 1) % 1;
    return weather.data[(Math.floor(v * S) * S + Math.floor(u * S)) * 4 + ch] / 255;
  };
  let time = 0;
  return {
    pass, preset: P,
    update(dt) { time += dt; mat.uniforms.uTime.value = time; },
    insideAt(p) {
      const wx = p.x + time * 3.5, wz = p.z + time * 1.3;
      const seaTop = P.sea[1] + (wAt(wx, wz, 1) - 0.5) * 2 * P.sea[2];
      if (p.y < seaTop) return 1;
      if (p.y > P.cu[0] && p.y < P.cu[1]) {
        const cov = Math.min(1, Math.max(0, (wAt(wx, wz, 0) - 0.38 + P.cu[3]) / 0.34)) * P.cu[2];
        const h = (p.y - P.cu[0]) / (P.cu[1] - P.cu[0]);
        return cov > 0.45 && h < 0.15 + 0.75 * cov ? (cov - 0.45) * 2 : 0;
      }
      return 0;
    },
  };
}
