// The living leaf's body, face and stage in three.js: a plump quaking aspen
// blade with its pointed tip and fine teeth, a flat stem that curls to the
// left like the pixel leaf's, glossy Char eyes with lids and two catchlights,
// a mouth for working, the Gold badge for "needs you", a key, rim and fill
// light, and a soft contact shadow for the big sizes. The blade flexes in its
// vertex shader (twist, bend, cup), so posing it is only a few numbers; the
// face rides the same flex, mirrored here on the CPU.
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CustomBlending,
  DirectionalLight,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  TorusGeometry,
  SRGBColorSpace,
  Vector3,
  ZeroFactor,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { clamp, mix } from "./motion";
import type { Pose } from "./pose";

/** The Cloudflare palette of the pixel leaf (research/design/pando-ui-2026-10-03/assistant-icon/_src/px.mjs). */
export const PALETTE = { flare: "#ff5e1e", amber: "#f6821f", gold: "#ffce4b", ember: "#b84c00", char: "#3d1e0f" };

// ---------------------------------------------------------------- the blade --

/** Height of the blade's centre above the stem joint, in blade radii. */
const CY = 0.84;

/** Front and back thickness, and the superellipse power that makes it a plump pillow with a round edge. */
const FRONT = 0.21;

const BACK = 0.12;

const POW = 2.6;

/** The blade's length from the joint to the tip, for the twist's falloff. */
const SPAN = 2.1;

/** The pixel leaf is a little wider than tall: the blade is stretched across by this much. */
const WIDE = 1.07;

/** The blade's outline: round, a short pointed tip at the top, a flatter base with a small notch at the stem, fine round teeth. */
function outline(th: number) {
  const up = Math.max(0, Math.cos(th - Math.PI / 2));
  const down = Math.max(0, -Math.sin(th));
  const tip = 0.19 * up ** 34;
  const teeth = 0.007 * (1 - up ** 4) * Math.sin(th * 34);

  return { body: 1 + tip - 0.08 * down ** 3 - 0.05 * down ** 40, teeth };
}

/** The outline's radius, the teeth only at the very edge so they do not ridge the blade. */
const radius = (th: number, rho: number) => {
  const o = outline(th);

  return (o.body + o.teeth * rho ** 8) * rho;
};

/** The front surface's height over the blade at (x, y) in joint space. */
function frontZ(x: number, y: number) {
  const dy = y - CY;
  const rho = clamp(Math.hypot(x / WIDE, dy) / outline(Math.atan2(dy, x / WIDE)).body);

  return FRONT * (1 - rho ** POW) ** (1 / POW);
}

function bladeGeometry(around = 120, across = 36) {
  const pos: number[] = [];
  const edge: number[] = [];
  const index: number[] = [];

  for (let j = 0; j <= across; j++) {
    const phi = (j / across) * Math.PI;
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const rho = Math.abs(s) ** (2 / POW);
    const z = Math.sign(c) * Math.abs(c) ** (2 / POW) * (c >= 0 ? FRONT : BACK);

    for (let i = 0; i < around; i++) {
      const th = (i / around) * Math.PI * 2;
      const r = radius(th, rho);

      pos.push(WIDE * r * Math.cos(th), CY + r * Math.sin(th), z);
      edge.push(rho);
    }
  }

  for (let j = 0; j < across; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * around + i;
      const b = j * around + ((i + 1) % around);

      index.push(a, a + around, b, b, a + around, b + around);
    }
  }

  const g = new BufferGeometry();

  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aEdge", new BufferAttribute(new Float32Array(edge), 1));
  g.setIndex(index);
  g.computeVertexNormals();
  // The two poles are flat: give them straight normals so no pinch shows between the eyes.
  const n = g.getAttribute("normal");

  for (let i = 0; i < around; i++) {
    n.setXYZ(i, 0, 0, 1);
    n.setXYZ(across * around + i, 0, 0, -1);
  }

  return g;
}

/** The blade's flex, the same as the vertex shader's: bend and cup move z, twist turns about the stem axis. */
function flex(p: Vector3, pose: Pose) {
  p.z += pose.bend * 0.5 * p.y * p.y - pose.cup * p.x * p.x;
  const a = pose.twist * Math.max(0, p.y / SPAN) ** 1.5;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = c * p.x + s * p.z;

  p.z = -s * p.x + c * p.z;
  p.x = x;

  return p;
}

const FLEX_VERTEX = `
uniform float uTwist; uniform float uBend; uniform float uCup;
varying vec3 vLeaf; varying float vEdge;
attribute float aEdge;
vec2 leafTurn(vec2 xz, float y) {
  float a = uTwist * pow(max(y / ${SPAN.toFixed(2)}, 0.0), 1.5);
  float c = cos(a), s = sin(a);
  return vec2(c * xz.x + s * xz.y, -s * xz.x + c * xz.y);
}`;

const FLEX_NORMAL = `
  objectNormal.xy -= vec2(-2.0 * uCup * position.x, uBend * position.y) * objectNormal.z;
  objectNormal = normalize(objectNormal);
  objectNormal.xz = leafTurn(objectNormal.xz, position.y);`;

const FLEX_POSITION = `
  vLeaf = position; vEdge = aEdge;
  transformed.z += uBend * 0.5 * position.y * position.y - uCup * position.x * position.x;
  transformed.xz = leafTurn(transformed.xz, position.y);`;

// The colour of the blade, as the pixels place it: Gold along the upper-left edge and the tip, Ember on the lower-right edge,
// Flare between with a warmer Amber heart, and a paler underside. One-colour tones replace all of it.
const BLADE_COLOUR = `
  {
    vec2 d = normalize(vLeaf.xy - vec2(0.0, ${CY.toFixed(2)}) + 1e-5);
    float rim = smoothstep(0.7, 0.98, vEdge);
    float gold = rim * smoothstep(-0.2, 0.7, dot(d, normalize(vec2(-0.72, 0.7))));
    float ember = smoothstep(0.5, 0.98, vEdge) * smoothstep(-0.15, 0.8, dot(d, normalize(vec2(0.74, -0.67))));
    vec3 c = mix(uFlare, uAmber, 0.35 * (1.0 - vEdge) * smoothstep(-0.7, 0.9, vLeaf.y - ${CY.toFixed(2)}));
    c = mix(c, uEmber, 0.85 * ember);
    c = mix(c, uGold, gold);
    c = mix(c, uGold, 0.35 * smoothstep(0.02, -0.04, vLeaf.z));
    diffuseColor.rgb = mix(c, uTone, uToneK);
  }`;

// Light the key would scatter through a thin leaf shows as warmth on the far side; a fresnel rim cuts the outline out.
const GLOW = `
  {
    vec3 V = normalize(vViewPosition);
    float ndv = clamp(dot(normal, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 2.4);
    vec3 keyDir = normalize((viewMatrix * vec4(-0.5, 0.7, 0.55, 0.0)).xyz);
    float back = clamp(0.5 - 0.5 * dot(normal, keyDir), 0.0, 1.0);
    totalEmissiveRadiance += uWarm * uWarmK * back * (0.35 + 0.65 * ndv);
    totalEmissiveRadiance += uRim * uRimK * fres;
  }`;

interface SkinUniforms {
  uFlare: { value: Color };
  uAmber: { value: Color };
  uGold: { value: Color };
  uEmber: { value: Color };
  uTone: { value: Color };
  uToneK: { value: number };
  uWarm: { value: Color };
  uWarmK: { value: number };
  uRim: { value: Color };
  uRimK: { value: number };
  uTwist: { value: number };
  uBend: { value: number };
  uCup: { value: number };
}

function skinUniforms(): SkinUniforms {
  return {
    uFlare: { value: new Color(PALETTE.flare) },
    uAmber: { value: new Color(PALETTE.amber) },
    uGold: { value: new Color(PALETTE.gold) },
    uEmber: { value: new Color(PALETTE.ember) },
    uTone: { value: new Color("#8f8f8f") },
    uToneK: { value: 0 },
    uWarm: { value: new Color("#ff7a1a") },
    uWarmK: { value: 0.32 },
    uRim: { value: new Color(PALETTE.gold) },
    uRimK: { value: 0.3 },
    uTwist: { value: 0 },
    uBend: { value: 0 },
    uCup: { value: 0 },
  };
}

/** A physically based skin with the leaf's shader additions; `blade` adds the flex and the pixel colours. */
function skin(u: SkinUniforms, blade: boolean, colour: string) {
  const m = new MeshPhysicalMaterial({
    color: colour,
    roughness: 0.48,
    clearcoat: 0.3,
    clearcoatRoughness: 0.32,
    envMapIntensity: 0.55,
  });

  m.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
    Object.assign(sh.uniforms, u);
    const pars = "#include <common>\nuniform vec3 uFlare; uniform vec3 uAmber; uniform vec3 uGold; uniform vec3 uEmber; uniform vec3 uTone; uniform float uToneK; uniform vec3 uWarm; uniform float uWarmK; uniform vec3 uRim; uniform float uRimK;";

    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", blade ? `${pars}\nvarying vec3 vLeaf; varying float vEdge;` : pars)
      .replace("#include <color_fragment>", blade ? `#include <color_fragment>\n${BLADE_COLOUR}` : "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uTone, uToneK);")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${GLOW}`);

    if (blade) {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>\n${FLEX_VERTEX}`)
        .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\n${FLEX_NORMAL}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${FLEX_POSITION}`);
    }
  };

  m.customProgramCacheKey = () => (blade ? "leaf-blade-1" : "leaf-skin-1");

  return m;
}

// ----------------------------------------------------------------- the stem --

const STEM = 0.7;

const STEM_START = -0.05;

/** The stem's centre line at distance s from the joint, for curvature k: an arc that turns to the left. */
function stemPoint(s: number, k: number) {
  const kk = Math.max(k, 1e-3);

  return { x: (Math.cos(STEM_START + kk * s) - Math.cos(STEM_START)) / kk, y: (Math.sin(STEM_START) - Math.sin(STEM_START + kk * s)) / kk };
}

/** A flattened, tapering tube along -y with a round end; the vertex shader bends it into the arc. */
function stemGeometry(along = 18, around = 12) {
  const pos: number[] = [];
  const index: number[] = [];
  const cap = 0.045;
  const rings = along + 4;

  for (let j = 0; j <= rings; j++) {
    const capT = Math.max(0, (j - along) / 4);
    const s = j <= along ? (j / along) * STEM : STEM + cap * Math.sin((capT * Math.PI) / 2);
    const taper = 1 - 0.45 * Math.min(1, s / STEM);
    const round = Math.cos((capT * Math.PI) / 2);

    for (let i = 0; i < around; i++) {
      const a = (i / around) * Math.PI * 2;

      pos.push(Math.cos(a) * 0.075 * taper * round, -s, Math.sin(a) * 0.05 * taper * round - 0.03);
    }
  }

  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * around + i;
      const b = j * around + ((i + 1) % around);

      index.push(a, b, a + around, b, b + around, a + around);
    }
  }

  const g = new BufferGeometry();

  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(index);
  g.computeVertexNormals();

  return g;
}

const STEM_VERTEX = `
uniform float uCurl;
vec2 stemAt(float s) {
  float k = max(uCurl, 1e-3);
  return vec2(cos(${STEM_START.toFixed(2)} + k * s) - cos(${STEM_START.toFixed(2)}), sin(${STEM_START.toFixed(2)}) - sin(${STEM_START.toFixed(2)} + k * s)) / k;
}`;

const STEM_NORMAL = `
  {
    float a = ${STEM_START.toFixed(2)} + max(uCurl, 1e-3) * (-position.y);
    objectNormal.xy = vec2(objectNormal.x * cos(a) + objectNormal.y * sin(a), -objectNormal.x * sin(a) + objectNormal.y * cos(a));
  }`;

const STEM_POSITION = `
  {
    float s = -position.y;
    float a = ${STEM_START.toFixed(2)} + max(uCurl, 1e-3) * s;
    transformed = vec3(stemAt(s) + position.x * vec2(cos(a), -sin(a)), position.z);
  }`;

function stemSkin(u: SkinUniforms, curl: { value: number }) {
  const m = new MeshPhysicalMaterial({ color: PALETTE.ember, roughness: 0.5, clearcoat: 0.2, clearcoatRoughness: 0.4, envMapIntensity: 0.6 });

  m.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
    Object.assign(sh.uniforms, u, { uCurl: curl });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${STEM_VERTEX}`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\n${STEM_NORMAL}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${STEM_POSITION}`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uTone; uniform float uToneK; uniform vec3 uWarm; uniform float uWarmK; uniform vec3 uRim; uniform float uRimK;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uTone, uToneK);")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${GLOW}`);
  };

  m.customProgramCacheKey = () => "leaf-stem-1";

  return m;
}

// ----------------------------------------------------------------- the face --

/** Eye layout in joint space, read off the pixel leaf: columns 5 and 10, rows 7 and 8 of 16. */
const EYE_X = 0.38;

const EYE_Y = CY - 0.17;

const EYE = { w: 0.11, h: 0.172, d: 0.08 };

const MOUTH_Y = CY - 0.5;

interface Eye {
  side: number;
  root: Group;
  scaled: Group;
  ball: Mesh;
  upper: Mesh;
  /** The closed, happy arc of done: the eye squeezes shut into it. */
  arc: Mesh;
  glints: [Mesh, Mesh];
}

function radial(stops: [number, string][]): Texture {
  const c = document.createElement("canvas");

  c.width = c.height = 128;
  const g = c.getContext("2d");

  if (g) {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);

    for (const [p, col] of stops) gr.addColorStop(p, col);
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  }

  const t = new CanvasTexture(c);

  t.colorSpace = SRGBColorSpace;

  return t;
}

export type Framing = "icon" | "hero";

/** The ground point under the joint is the body's origin; the joint sits this high at rest. */
const JOINT = -stemPoint(STEM + 0.03, 1.5).y;

export class LeafRig {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(20, 1, 1, 40);
  private readonly body = new Group();
  private readonly joint = new Group();
  private readonly face = new Group();
  private readonly u = skinUniforms();
  private readonly lidU = skinUniforms();
  private readonly curl = { value: 1.5 };
  private readonly eyes: Eye[];
  private readonly mouth: Mesh;
  private readonly badge: Mesh;
  private readonly foot: Mesh;
  private readonly pool: Mesh;
  private readonly footMat = new MeshBasicMaterial();
  private readonly poolMat = new MeshBasicMaterial();
  private readonly eyeMat: MeshPhysicalMaterial;
  private readonly holeMat: MeshBasicMaterial;
  private readonly glintMat: MeshBasicMaterial;
  private framing: Framing = "icon";
  /** Optical sizing: the eyes and badge grow a little as the leaf gets small, so they read at 24 px. */
  private boost = 1;
  private readonly basis = new Matrix4();
  private readonly v = new Vector3();

  constructor() {
    const { scene } = this;
    const blade = new Mesh(bladeGeometry(), skin(this.u, true, PALETTE.flare));
    const stem = new Mesh(stemGeometry(), stemSkin(this.u, this.curl));

    stem.frustumCulled = false;
    stem.position.y = JOINT;
    blade.frustumCulled = false;
    this.joint.add(blade, this.face);
    this.body.add(stem, this.joint);
    scene.add(this.body);
    this.joint.rotation.order = "ZXY";
    this.body.rotation.order = "ZXY";

    // Eyes: Char, glossy under a clearcoat, half sunk into the blade. Lids are blade-coloured shells.
    this.lidU.uWarmK.value = 0.25;
    const lidMat = skin(this.lidU, false, "#f4601d");

    this.eyeMat = new MeshPhysicalMaterial({ color: PALETTE.char, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.1 });
    // In one colour the eyes are holes, as in the pixel leaf's mono version: they write a clear pixel.
    this.holeMat = new MeshBasicMaterial({ blending: CustomBlending, blendEquation: AddEquation, blendSrc: ZeroFactor, blendDst: ZeroFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: ZeroFactor });
    this.glintMat = new MeshBasicMaterial({ color: "#fff8ee", toneMapped: false });
    const ball = new SphereGeometry(1, 32, 24);
    const upperLid = new SphereGeometry(1.08, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const arc = new TorusGeometry(1, 0.36, 10, 28, Math.PI);
    const glint = new SphereGeometry(1, 12, 8);

    this.eyes = [-1, 1].map((side) => {
      const root = new Group();
      const scaled = new Group();

      const e: Eye = {
        side,
        root,
        scaled,
        ball: new Mesh(ball, this.eyeMat),
        upper: new Mesh(upperLid, lidMat),
        arc: new Mesh(arc, this.eyeMat),
        glints: [new Mesh(glint, this.glintMat), new Mesh(glint, this.glintMat)],
      };

      scaled.add(e.ball, e.upper);
      root.add(scaled, e.arc, ...e.glints);
      this.face.add(root);

      return e;
    });

    this.mouth = new Mesh(ball, new MeshPhysicalMaterial({ color: "#2a1208", roughness: 0.35, clearcoat: 0.6 }));
    this.face.add(this.mouth);

    this.badge = new Mesh(new SphereGeometry(1, 32, 24), new MeshPhysicalMaterial({ color: PALETTE.gold, emissive: PALETTE.gold, emissiveIntensity: 0.35, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 }));
    this.body.add(this.badge);

    // The contact shadow: a tight dark spot under the stem's tip and a wide soft pool under the blade.
    const spot = radial([[0, "rgba(61,30,15,0.7)"], [0.5, "rgba(61,30,15,0.25)"], [1, "rgba(61,30,15,0)"]]);

    for (const m of [this.footMat, this.poolMat]) Object.assign(m, { map: spot, transparent: true, depthWrite: false, toneMapped: false });

    this.foot = new Mesh(new PlaneGeometry(1, 1), this.footMat);
    this.pool = new Mesh(new PlaneGeometry(1, 1), this.poolMat);

    for (const m of [this.foot, this.pool]) {
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = -1;
      scene.add(m);
    }

    // Key: warm white from the upper left, the side the pixels edge in Gold. Rim: warm gold from behind right. Fill: low and soft, so shadows stay Ember, not black.
    const key = new DirectionalLight("#fff3e6", 1.7);

    key.position.set(-3.5, 6, 6);
    const rim = new DirectionalLight("#ffc77a", 1.8);

    rim.position.set(5, 3.5, -5);
    const fill = new DirectionalLight("#ffe2d0", 0.35);

    fill.position.set(5, 0.5, 6);
    scene.add(key, rim, fill, new HemisphereLight("#fff4ea", "#7a3410", 0.25));
    this.frame("icon", 24);
  }

  /** Icon framing fills the box like the pixel leaf, seen straight on; hero framing leaves room to hop and shows the ground. */
  frame(f: Framing, size: number) {
    this.framing = f;
    this.boost = size <= 28 ? 1.4 : size < 64 ? 1.2 : 1;
    const cam = this.camera;
    const icon = f === "icon";
    const centre = icon ? 1.36 : 1.55;
    const half = icon ? 1.5 : 1.85;
    const dist = 13;
    const lift = icon ? 0.25 : 1.6;

    cam.position.set(0, centre + lift, dist);
    cam.fov = (2 * Math.atan(half / dist) * 180) / Math.PI;
    cam.updateProjectionMatrix();
    cam.lookAt(0, centre, 0);
    this.foot.visible = !icon;
    this.pool.visible = !icon;
  }

  /** Pose the leaf, in its own colours or one tone (a CSS colour). Under icon framing, moves through space are scaled down so it stays in its box. */
  pose(p: Pose, toneColour: string | null) {
    const icon = this.framing === "icon";
    const travel = icon ? 0.35 : 1;
    const sq = Math.max(0.5, p.sq);
    const wide = 1 / Math.sqrt(sq);
    const tone = toneColour !== null;

    // Body: squash and stretch about the ground, a share of the lean and nod (it balances on its stem), the whole turn.
    this.body.position.set(p.x * travel, p.y * travel, 0);
    this.body.scale.set(wide, sq, wide);
    this.body.rotation.set(p.pitch * 0.35, p.yaw, p.lean * 0.35);
    this.joint.position.set(0, JOINT, 0);
    this.joint.rotation.set(p.pitch * 0.65, 0, p.lean * 0.65);
    this.u.uTwist.value = p.twist;
    this.u.uBend.value = p.bend;
    this.u.uCup.value = p.cup;
    this.curl.value = p.curl;

    // Colours: the leaf's own, or one tone.
    for (const u of [this.u, this.lidU]) {
      u.uToneK.value = tone ? 1 : 0;

      if (toneColour) u.uTone.value.setStyle(toneColour);

      u.uWarmK.value = tone ? 0 : u === this.u ? 0.32 : 0.25;
      u.uRim.value.setStyle(toneColour ?? PALETTE.gold);
      u.uRimK.value = tone ? 0.15 : 0.3;
    }

    // The face: an icon's eyes are a touch bigger, so they read at 24 px.
    const { boost } = this;

    for (const e of this.eyes) this.eye(e, p, boost, tone);

    const open = clamp(p.mouth);

    this.mouth.visible = open > 0.02 && !tone;
    this.place(this.mouth, p.gx * 0.02, MOUTH_Y + p.gy * 0.012, 0.01, p);
    this.mouth.scale.set(0.12 * (1 - 0.2 * open) * boost, 0.11 * open * boost, 0.03);

    const b = Math.max(0, p.badge);

    this.badge.visible = b > 0.01 && !tone;
    this.badge.scale.setScalar(0.2 * b * Math.sqrt(boost));
    this.badge.position.set(1.08, JOINT + 1.95, 0.25);

    if (!icon) this.shadow(p, travel, sq);
  }

  /** A point on the blade's front at (fx, fy) in joint space, pushed out along its normal by `out`, with the blade's flex. */
  private place(m: Group | Mesh, fx: number, fy: number, sink: number, p: Pose) {
    const z = frontZ(fx, fy);
    const o = flex(this.v.set(fx, fy, z), p).clone();
    const e = 0.01;
    const ax = flex(this.v.set(fx + e, fy, frontZ(fx + e, fy)), p).clone().sub(o);
    const ay = flex(this.v.set(fx, fy + e, frontZ(fx, fy + e)), p).clone().sub(o);
    const n = new Vector3().crossVectors(ax, ay).normalize();
    const up = ay.normalize();
    const right = new Vector3().crossVectors(up, n).normalize();

    up.crossVectors(n, right);
    this.basis.makeBasis(right, up, n);
    m.position.copy(o).addScaledVector(n, -sink);
    m.quaternion.setFromRotationMatrix(this.basis);
  }

  private eye(e: Eye, p: Pose, boost: number, tone: boolean) {
    const gx = clamp(p.gx, -1.2, 1.2);
    const gy = clamp(p.gy, -1.2, 1.2);
    // The eyes drift toward the gaze; the near eye travels a touch more.
    const fx = e.side * EYE_X + gx * 0.07 + (e.side * gx > 0 ? 0.01 : -0.01);
    const fy = EYE_Y + gy * 0.07;
    const sc = p.wide * boost;
    const w = EYE.w * sc * (1 - 0.1 * Math.abs(gx));

    // Squint: the eye squeezes shut into a happy arc, as the pixel leaf's done eyes.
    const sq = clamp(p.squint * (1 - p.blink));

    this.place(e.root, fx, fy, EYE.d * 0.3, p);
    e.scaled.scale.set(w, EYE.h * sc * Math.max(0.001, 1 - sq), EYE.d * sc);
    e.ball.material = tone ? this.holeMat : this.eyeMat;
    e.arc.material = e.ball.material;
    e.arc.visible = sq > 0.01;
    e.arc.scale.set(w * 1.3 * sq, w * 1.4 * sq, w * sq);
    e.arc.position.set(0, -0.25 * EYE.h * sc, EYE.d * sc * 0.45);
    // Upper lid: 0 tucks it away, 1 shuts the eye; it follows the gaze down as real lids do.
    const shut = clamp(Math.max(p.blink, p.lid + Math.max(0, -gy) * 0.2));

    e.upper.rotation.x = mix(-1.95, Math.PI / 2 + 0.05, shut);
    // Catchlights stay toward the key light while the eye moves.
    const vis = clamp((1 - Math.max(shut, sq)) / 0.35) * (tone ? 0 : 1);
    const [g1, g2] = e.glints;

    g1.visible = g2.visible = vis > 0.01;
    g1.position.set(-0.3 * w, 0.36 * EYE.h * sc, EYE.d * sc * 0.9);
    g1.scale.set(0.3 * w * vis, 0.36 * w * vis, 0.3 * w * vis);
    g2.position.set(0.28 * w, -0.32 * EYE.h * sc, EYE.d * sc * 0.92);
    g2.scale.setScalar(0.13 * w * vis);
  }

  private shadow(p: Pose, travel: number, sq: number) {
    const h = Math.max(0, p.y * travel);
    const tip = stemPoint(STEM + 0.03, p.curl);
    const yaw = p.yaw;
    const fx = p.x * travel + tip.x * Math.cos(yaw) / Math.sqrt(sq);
    const fz = -tip.x * Math.sin(yaw);
    const footH = h + Math.max(0, JOINT + tip.y);

    this.foot.position.set(fx, 0.002, fz);
    this.foot.scale.setScalar(0.42 * (1 + footH * 1.2));
    this.footMat.opacity = 0.85 / (1 + footH * 5);
    this.pool.position.set(p.x * travel + 0.15, 0.001, -0.25);
    this.pool.scale.set(2.5 * (1 + h * 0.3), 1.1 * (1 + h * 0.3), 1);
    this.poolMat.opacity = 0.42 / (1 + h * 1.5);
  }
}
