import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Accent, DriveMode, PageId, XrayMode } from "../state";

export interface CarScene {
  setAccent(accent: Accent): void;
  setLights(beams: boolean, taillights: boolean): void;
  setXray(mode: XrayMode): void;
  setDriveMode(mode: DriveMode): void;
  setRideHeight(steps: number): void;
  setPage(page: PageId): void;
  /**
   * Dash mode: render the scene as a mini aerial view inside this screen
   * rect (CSS px, top-left origin) instead of full-screen. null restores
   * the normal full-viewport render.
   */
  setMiniView(rect: { x: number; y: number; w: number; h: number } | null): void;
}

const RED = new THREE.Color(1.0, 0.18, 0.18);
const WHITE = new THREE.Color(0.95, 0.95, 0.95);

const GLOW_BY_MODE: Record<DriveMode, number> = {
  comfort: 0.45,
  balance: 0.8,
  sport: 1.3,
  custom: 1.0,
};

/**
 * Signature stage angle per page (yaw of the car group). Home shows the
 * front 3/4 (DRL bar + hood); Vehicle shows the rear 3/4 (lightbar,
 * spoiler, diffuser) offset behind the settings panel. Page changes ease
 * to these; dragging stays free until the next page change.
 */
const VIEW_BY_PAGE: Record<PageId, number> = {
  home: Math.PI + 1.75, // front-left: camera sits at (5.6,·,6.4), so pure
  // driver's-side profile is PI+0.72 — rotate ~59deg past it toward the nose
  vehicle: -0.55 + Math.PI, // rear 3/4 behind the settings panel
  dash: Math.PI / 2, // nose up under the aerial mini-view camera
  climate: Math.PI + 1.75,
  navigate: Math.PI + 1.75,
};

/**
 * Camera height + aim point per page. Home rides low (~waist height) for a
 * ground-level hero angle with a flat horizon; Vehicle keeps the higher
 * survey view over the settings panel.
 */
const CAM_BY_PAGE: Record<PageId, { y: number; aimY: number }> = {
  home: { y: 1.15, aimY: 0.65 },
  vehicle: { y: 2.45, aimY: 0.75 },
  dash: { y: 1.15, aimY: 0.65 }, // main camera idles low; it's hidden behind
  // the dash backdrop while the aerial camera draws the mini view
  climate: { y: 1.15, aimY: 0.65 },
  navigate: { y: 1.15, aimY: 0.65 },
};

/**
 * Node names the loader toggles for the exterior lamp groups. The GLB models
 * them as: `Headlights_On` (empty parenting both pods), `DRL` (the light
 * blade across the nose), and `Brake_Lights_On` / `Brake_Lights_Off` bars.
 */
const BEAM_NODES = ["Headlights_On", "DRL"];
const TAIL_ON_NODES = ["Brake_Lights_On"];
const TAIL_OFF_NODES = ["Brake_Lights_Off"];
/** HDR multiplier on the tail emissives (additive + toneMapped:false lets it pass 1.0). */
const TAIL_BOOST = 2.2;

/** Emissive materials that should glow additively on the OLED black. */
const ADDITIVE_MATS = new Set(["Light", "Beam"]);

/**
 * Finish overrides applied on load. The GLB ships plausible PBR values, but
 * the stage reads better with hand-tuned neutral silver paint and gloss-black
 * turbine rims; the light interior tones also need metalness forced off (the
 * exporter omits metallicFactor and three would default it to 1).
 */
const MATTE_COLORS: Record<string, { c: number; metal?: number }> = {
  PaintSkybox: { c: 0x878c93 }, // Quicksilver-ish: neutral, slightly cool silver
  // Turbine rims: grayscale multiplier + metalness 1 = gloss black
  Helix2: { c: 0x454a50 },
  Seats: { c: 0xd9d6d0, metal: 0 },
  Interior: { c: 0xc9c6c0, metal: 0 },
  Pillar: { c: 0x3f4348, metal: 0 }, // seen through smoked glass: near-charcoal
};

/**
 * Tinted glass reads as near-black on our black stage, so give it a dark
 * glossy metallic finish that catches the studio strips instead.
 */
const GLASS_MATS = new Set(["GlassWindowsDark", "GlassSkybox"]);

/**
 * Materials that stay solid when the wireframe HUD x-rays the body — the
 * interior floating inside the ghost shell is the whole point of the look.
 */
const SOLID_MATS = new Set([
  "Seats",
  "Interior",
  "Pillar",
  "Display",
  "ChargePort",
  // Wheels stay solid under x-ray so the car stays grounded on its wheels
  "Helix2", // turbine rim
  "Pirelli", // tire
  "Brakes", // disc + caliper
]);

/** Ghost-shell opacity at full x-ray (0 = pure line-art, 0.15 = glassier). */
const XRAY_OPACITY = 0.02;
/** Glass keeps a much denser ghost so the canopy stays readable in x-ray. */
const XRAY_GLASS_OPACITY = 0.25;

/**
 * Remap a baseColor texture in place (kept for texture-bearing exports; the
 * current GLB is untextured so this is a no-op pass).
 */
function lightenMap(mat: THREE.MeshStandardMaterial, mul: number, add: number) {
  const img = mat.map?.image as HTMLImageElement | ImageBitmap | undefined;
  if (!img) return;
  const w = img.width,
    h = img.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i] = Math.min(255, d.data[i] * mul + add);
    d.data[i + 1] = Math.min(255, d.data[i + 1] * mul + add);
    d.data[i + 2] = Math.min(255, d.data[i + 2] * mul + add);
  }
  ctx.putImageData(d, 0, 0);
  mat.map!.image = c;
  mat.map!.needsUpdate = true;
}

/** Soft radial falloff used for the drive-mode underglow. */
function radialGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(0.65, "rgba(255,255,255,0.10)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/** Soft elliptical ground shadow (black core fading out) for contact cues. */
function contactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 12, 128, 128, 128);
  g.addColorStop(0, "rgba(0,0,0,0.9)");
  g.addColorStop(0.5, "rgba(0,0,0,0.6)");
  g.addColorStop(0.78, "rgba(0,0,0,0.22)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/** Side profile of the Model Y Juniper (fallback if the GLB fails to load). */
function bodyProfile(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(2.28, 0.30);
  s.quadraticCurveTo(2.44, 0.36, 2.42, 0.60); // rounded low nose
  s.quadraticCurveTo(2.40, 0.80, 2.14, 0.88); // fascia top blends into hood
  s.lineTo(1.35, 1.00); // hood
  s.quadraticCurveTo(1.02, 1.04, 0.78, 1.30); // raked windshield base
  s.lineTo(0.42, 1.50); // A-pillar
  s.lineTo(-0.75, 1.52); // roof
  s.lineTo(-1.86, 1.24); // rear glass (straighter hatch)
  s.quadraticCurveTo(-2.14, 1.14, -2.30, 1.04); // ducktail lip
  s.quadraticCurveTo(-2.38, 0.86, -2.36, 0.62); // tailgate face
  s.lineTo(-2.28, 0.30);
  s.closePath();
  return s;
}

/** Minimal wireframe-ish Juniper used only if models/car.glb cannot be fetched. */
function buildFallbackCar(): THREE.Group {
  const g = new THREE.Group();
  const bodyGeo = new THREE.ExtrudeGeometry(bodyProfile(), {
    depth: 1.86,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2,
    curveSegments: 10,
  });
  bodyGeo.translate(0, 0, -0.93);
  g.add(
    new THREE.Mesh(
      bodyGeo,
      new THREE.MeshStandardMaterial({
        color: 0x0e1116,
        metalness: 0.55,
        roughness: 0.32,
        transparent: true,
        opacity: 0.93,
      })
    )
  );
  g.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(bodyGeo, 26),
      new THREE.LineBasicMaterial({ color: 0xb9c2cf, transparent: true, opacity: 0.45 })
    )
  );
  const tireGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.22, 28);
  tireGeo.rotateX(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.92 });
  for (const wx of [1.45, -1.45]) {
    for (const wz of [0.86, -0.86]) {
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.position.set(wx, 0.4, wz);
      g.add(tire);
    }
  }
  const tailBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.05, 1.72),
    new THREE.MeshBasicMaterial({ color: 0xff2222 })
  );
  tailBar.position.set(-2.37, 1.0, 0);
  tailBar.name = "FallbackTail";
  g.add(tailBar);
  return g;
}

/**
 * Baked "studio strip" environment: a handful of HDR emissive panels fed to a
 * PMREM. Gives the metallic paint sharp showroom streaks that slide along the
 * bodywork while the rest of the scene stays OLED-black — a full room env
 * flattened the mood.
 */
function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  // Dim cyclorama dome: base reflection so vertical panels read as silver
  // instead of black; the strips on top of it carry the sharp streaks.
  env.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(12, 24, 16),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setScalar(0.32),
        side: THREE.BackSide,
      }),
    ),
  );
  const panel = (
    w: number,
    h: number,
    pos: [number, number, number],
    intensity: number,
  ) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setScalar(intensity),
        side: THREE.DoubleSide,
      }),
    );
    m.position.set(...pos);
    m.lookAt(0, 1, 0);
    env.add(m);
  };
  panel(10, 5, [0, 6, 0], 3.6); // ceiling softbox
  panel(9, 1.0, [0, 2.7, -7], 3.0); // rear strip: long streak across the sides
  panel(9, 0.8, [0, 1.6, 7], 1.8); // front strip, weaker
  panel(7, 1.1, [-7, 2.3, 0], 2.6); // left strip
  panel(7, 1.1, [7, 2.3, 0], 2.6); // right strip
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.05).texture;
  pmrem.dispose();
  return tex;
}

export function initCarScene(canvas: HTMLCanvasElement): CarScene {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = false; // tick() clears explicitly (mini view scissoring)

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.052);

  // Studio reflections so the metallic Quicksilver paint reads as silver
  // instead of near-black (metallic PBR has no diffuse term to light on).
  scene.environment = studioEnvironment(renderer);
  scene.environmentIntensity = 1.0;

  const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 80);
  camera.position.set(5.6, CAM_BY_PAGE.home.y, 6.4);
  camera.lookAt(0, 0.75, 0);

  // Dash mini view: near-top-down camera with a slight tilt so the car still
  // reads 3D. Rendered into a scissored corner rect (see setMiniView).
  const aerialCam = new THREE.PerspectiveCamera(35, 1.3, 0.1, 80);
  aerialCam.position.set(0, 10.5, 3.2);
  aerialCam.lookAt(0, 0.1, 0);

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__stage = { scene, camera, renderer, aerialCam };
  }

  // ---- lights (for the glossy body; emissives carry the rest) ----
  const ambient = new THREE.AmbientLight(0x262b31, 1.1);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xc6ccd2, 2.2);
  key.position.set(5, 7, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(RED.clone(), 1.0);
  rim.position.set(-6, 1.2, -5);
  scene.add(rim);

  // ---- car wrapper: rotation / ride height / page offset all live here ----
  const car = new THREE.Group();
  scene.add(car);

  // ---- drive-mode underglow (hologram pedestal feel) ----
  const underGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 2.6),
    new THREE.MeshBasicMaterial({
      color: RED.clone(),
      map: radialGlowTexture(),
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  underGlow.rotation.x = -Math.PI / 2;
  underGlow.position.y = 0.015;
  car.add(underGlow);

  // ---- contact shadow: soft dark ellipse under the footprint so the car
  // reads as pressed onto the dot grid instead of hovering above it ----
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 2.9),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: contactShadowTexture(),
      transparent: true,
      opacity: 0.65,
      depthWrite: false, // dots draw first (renderOrder -1) and get dimmed under it
      fog: false,
    })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 0.004;
  car.add(contactShadow);

  // ---- soft halo behind the lightbar: billboarded sprite so the fake
  // bloom always reads as glow, never as a flat sheet from oblique angles ----
  const tailHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      color: RED.clone(),
      map: radialGlowTexture(),
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
  );
  tailHalo.scale.set(2.2, 1.0, 1);
  tailHalo.position.set(-2.4, 0.95, 0);
  car.add(tailHalo);

  // ---- dot-grid floor: denser, circular (rotation exposes no square
  // edges), pinned to Chalk white so the stage reads the same in both themes ----
  const dotPositions: number[] = [];
  for (let x = -16; x <= 16; x += 0.45) {
    for (let z = -16; z <= 16; z += 0.45) {
      if (x * x + z * z > 16 * 16) continue; // circular field: rotation-invariant
      dotPositions.push(x, 0, z);
    }
  }
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute("position", new THREE.Float32BufferAttribute(dotPositions, 3));
  const dotMat = new THREE.PointsMaterial({
    color: new THREE.Color(242 / 255, 242 / 255, 242 / 255), // chalk, all themes
    size: 0.05,
    transparent: true,
    opacity: 0.4,
    sizeAttenuation: true,
    fog: true,
  });
  // stage group turns with the car (rotY) but never slides or lifts, so the
  // grid stays square to the car's axes on every page. renderOrder -1 so the
  // contact shadow (depthWrite off) always blends over the dots.
  const stage = new THREE.Group();
  const dotPoints = new THREE.Points(dotGeo, dotMat);
  dotPoints.renderOrder = -1;
  stage.add(dotPoints);
  scene.add(stage);

  // ---- the Juniper hologram (models/car.glb — original in-house Blender model) ----
  let beamsOn = true;
  let taillightsOn = true;
  const lightNodes = {
    beams: [] as THREE.Object3D[],
    tailOn: [] as THREE.Object3D[],
    tailOff: [] as THREE.Object3D[],
  };

  const applyLights = () => {
    for (const n of lightNodes.beams) n.visible = beamsOn;
    for (const n of lightNodes.tailOn) n.visible = taillightsOn;
    for (const n of lightNodes.tailOff) n.visible = !taillightsOn;
    tailHalo.visible = taillightsOn;
  };

  // x-ray registry: exterior materials ghost out when the HUD wireframe is on
  const xrayMats: {
    mat: THREE.MeshStandardMaterial;
    o0: number;
    t0: boolean;
    dw0: boolean;
    m0: number;
    r0: number;
    target: number;
  }[] = [];
  const xraySeen = new Set<THREE.Material>();

  const adoptModel = (root: THREE.Object3D) => {
    const lightened = new WeakSet<THREE.Material>();
    // glTF: nose towards -Z; our stage faces the nose towards +X like before.
    root.rotation.y = -Math.PI / 2;
    root.traverse((obj) => {
      const extras = (obj as THREE.Object3D & { extras?: { visible?: boolean } }).extras;
      if (extras?.visible === false) obj.visible = false;
      const meshes = (obj as THREE.Mesh).isMesh
        ? [(obj as THREE.Mesh)]
        : [];
      for (const mesh of meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            const over = MATTE_COLORS[mat.name];
            if (over !== undefined) {
              mat.color.setHex(over.c);
              if (over.metal !== undefined) mat.metalness = over.metal;
            }
            if (GLASS_MATS.has(mat.name)) {
              mat.color.setHex(0x222830);
              mat.metalness = 0.9;
              mat.roughness = 0.05;
              mat.envMapIntensity = 2.2;
              mat.opacity = 0.95; // near-opaque smoked glass
              mat.side = THREE.DoubleSide; // the glass band is a thin shell
            }
            if (!lightened.has(mat)) {
              if (mat.name === "Seats") {
                lightenMap(mat, 3.2, 110);
                lightened.add(mat);
              } else if (mat.name === "Interior") {
                lightenMap(mat, 3.0, 100);
                lightened.add(mat);
              }
            }
            if (
              !SOLID_MATS.has(mat.name) &&
              !ADDITIVE_MATS.has(mat.name) &&
              !xraySeen.has(mat)
            ) {
              xraySeen.add(mat);
              xrayMats.push({
                mat,
                o0: mat.opacity,
                t0: mat.transparent,
                dw0: mat.depthWrite,
                m0: mat.metalness,
                r0: mat.roughness,
                target: GLASS_MATS.has(mat.name) ? XRAY_GLASS_OPACITY : XRAY_OPACITY,
              });
            }
          }
          if (ADDITIVE_MATS.has(mat.name)) {
            mat.blending = THREE.AdditiveBlending;
            mat.transparent = true;
            mat.depthWrite = false;
            mat.toneMapped = false;
          }
        }
      }
    });
    for (const name of BEAM_NODES) {
      const n = root.getObjectByName(name);
      if (n) lightNodes.beams.push(n);
    }
    for (const name of TAIL_ON_NODES) {
      const n = root.getObjectByName(name);
      if (n) lightNodes.tailOn.push(n);
    }
    for (const name of TAIL_OFF_NODES) {
      const n = root.getObjectByName(name);
      if (n) lightNodes.tailOff.push(n);
    }
    // Isolate the tail emissives' materials (clone) and push them past 1.0 —
    // additive blending on OLED black accumulates, so the bar blooms harder.
    for (const n of lightNodes.tailOn) {
      n.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const clones = arr.map((m) => m.clone());
        for (const c of clones) {
          const std = c as THREE.MeshStandardMaterial;
          if (std.color) std.color.multiplyScalar(TAIL_BOOST);
        }
        mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
      });
    }
    car.add(root);
    applyLights();
  };

  let modelRoot: THREE.Object3D | null = null;

  new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .load(
      "models/car.glb",
      (gltf) => {
        adoptModel(gltf.scene);
        modelRoot = gltf.scene;
        // Pre-build the wireframe overlay while the stage is idle so the
        // HUD toggle is instant even on the slower in-car SoC.
        setTimeout(() => buildWireframe(gltf.scene), 2500);
      },
      undefined,
      (err) => {
        console.warn("car.glb failed to load, using fallback silhouette", err);
        const fb = buildFallbackCar();
        const tail = fb.getObjectByName("FallbackTail")!;
        lightNodes.tailOn.push(tail);
        car.add(fb);
        applyLights();
      }
    );

  // ---- wireframe HUD overlay (EdgesGeometry hard-edge pass) ----
  let wireBuilt = false;
  let wireOn = false;
  const wireLines: THREE.LineSegments[] = [];
  const wireMat = new THREE.LineBasicMaterial({
    color: RED.clone(),
    transparent: true,
    opacity: 0.85,
    toneMapped: false,
    fog: false,
  });

  /**
   * One LineSegments per *material group* (not per mesh): welded meshes mix
   * body/glass/culled-fade groups, and we only want edges of the drawn ones.
   * Sub-geometries share the parent position buffer; only the index is sliced.
   */
  function buildWireframe(root: THREE.Object3D) {
    if (wireBuilt) return;
    wireBuilt = true;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (let p: THREE.Object3D | null = mesh; p; p = p.parent)
        if (!p.visible) return; // hidden subtree (defrost, badge, signals...)
      const geo = mesh.geometry;
      const index = geo.getIndex();
      const pos = geo.getAttribute("position");
      if (!index || !pos) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = Array.isArray(mesh.material)
        ? geo.groups
        : [{ start: 0, count: Infinity, materialIndex: 0 }];
      for (const g of groups) {
        const mi = Number((g as { materialIndex?: number }).materialIndex ?? 0);
        const mat = mats[mi] ?? mats[0];
        if (!mat || !mat.visible || ADDITIVE_MATS.has(mat.name)) continue;
        const sub = new THREE.BufferGeometry();
        sub.setAttribute("position", pos);
        const idx = index.array.slice(g.start, g.start + Math.min(g.count, index.count - g.start));
        sub.setIndex(new THREE.BufferAttribute(idx as Uint32Array, 1));
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(sub, 25), wireMat);
        line.visible = wireOn;
        line.renderOrder = 2; // draw after the ghost shell so edges stay crisp
        mesh.add(line); // inherits the mesh's transform
        wireLines.push(line);
      }
    });
  }

  // ---- interaction: drag rotate + inertia; page changes pose the car ----
  let rotY = VIEW_BY_PAGE.home;
  let rotTarget = rotY;
  let posing = false; // easing to rotTarget after a page change
  let velocity = 0;
  let dragging = false;
  let lastX = 0;
  const hint = document.getElementById("home-hint");

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    posing = false; // user takes over, even mid-transition
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    hint?.classList.add("hidden");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    rotY += dx * 0.008;
    velocity = dx * 0.008;
  });
  const endDrag = () => {
    dragging = false;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ---- reactive targets ----
  let glowTarget = GLOW_BY_MODE.balance;
  let heightTarget = 0;
  let groupXTarget = 0;
  let groupZTarget = 0;
  let camYTarget = CAM_BY_PAGE.home.y;
  let camAimY = CAM_BY_PAGE.home.aimY;
  let camAimYTarget = CAM_BY_PAGE.home.aimY;
  let accentColor = RED.clone();
  let dim = 1;
  let dimTarget = 1; // wireframe HUD dims the solid body to a blueprint base
  let xray = 0;
  let xrayTarget = 0; // 1 = body ghosted to a see-through shell
  let miniBox: { x: number; y: number; w: number; h: number } | null = null;

  // ---- resize ----
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);

  // ---- animation loop (paused when hidden) ----
  let running = true;
  const tick = () => {
    if (!running) return;
    requestAnimationFrame(tick);

    if (posing && !dragging) {
      // shortest way around to the page's signature angle
      const delta = Math.atan2(Math.sin(rotTarget - rotY), Math.cos(rotTarget - rotY));
      if (Math.abs(delta) < 0.0015) {
        rotY = rotTarget;
        posing = false;
      } else {
        rotY += delta * (reducedMotion ? 1 : 0.05);
      }
    } else if (!dragging) {
      rotY += velocity;
      velocity *= 0.94;
    }
    car.rotation.y = rotY;
    stage.rotation.y = rotY; // floor grid stays square to the car's axes

    const glowMat = underGlow.material as THREE.MeshBasicMaterial;
    glowMat.opacity += (0.06 + glowTarget * 0.07 - glowMat.opacity) * 0.08;
    car.position.y += (heightTarget - car.position.y) * 0.08;
    car.position.x += (groupXTarget - car.position.x) * 0.07;
    car.position.z += (groupZTarget - car.position.z) * 0.07;
    camera.position.y += (camYTarget - camera.position.y) * 0.06;
    camAimY += (camAimYTarget - camAimY) * 0.06;
    camera.lookAt(0, camAimY, 0); // re-aim as height/aim ease between pages
    glowMat.color.lerp(accentColor, 0.08);
    (rim.color as THREE.Color).lerp(accentColor, 0.08);
    wireMat.color.lerp(accentColor, 0.08);

    dim += (dimTarget - dim) * 0.06;
    key.intensity = 2.2 * dim;
    rim.intensity = 1.0 * dim;
    ambient.intensity = 1.1 * dim;
    scene.environmentIntensity = 0.3 + 0.7 * dim;

    if (xray !== xrayTarget) {
      const d = xrayTarget - xray;
      xray = Math.abs(d) < 0.004 ? xrayTarget : xray + d * 0.08;
      for (const e of xrayMats) {
        const m = e.mat;
        m.opacity = e.o0 + (e.target - e.o0) * xray;
        m.transparent = e.t0 || xray > 0.01;
        m.depthWrite = xray < 0.5 ? e.dw0 : false; // let interior + far edges show through
        // Metallic paint under alpha blend = patchy mirror reflections (the
        // "spotty" look). Kill the metal and even out roughness while ghosted.
        m.metalness = e.m0 * (1 - xray);
        if (!GLASS_MATS.has(m.name)) m.roughness = e.r0 + (0.5 - e.r0) * xray;
      }
    }

    if (miniBox) {
      // Dash: black out the whole canvas, then draw the aerial view into
      // just the mini panel's rect (three's scissor origin is bottom-left).
      const H = window.innerHeight;
      const { x, y, w, h } = miniBox;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, window.innerWidth, H);
      renderer.clear();
      renderer.setScissor(x, H - y - h, w, h);
      renderer.setViewport(x, H - y - h, w, h);
      renderer.setScissorTest(true);
      aerialCam.aspect = w / h;
      aerialCam.updateProjectionMatrix();
      renderer.render(scene, aerialCam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, window.innerWidth, H);
    } else {
      renderer.clear();
      renderer.render(scene, camera);
    }
  };
  requestAnimationFrame(tick);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
    } else if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  });

  return {
    setAccent(accent) {
      accentColor = accent === "red" ? RED.clone() : WHITE.clone();
    },
    setLights(beams, taillights) {
      beamsOn = beams;
      taillightsOn = taillights;
      applyLights();
    },
    setXray(mode) {
      wireOn = mode === "hud";
      if (!wireBuilt && modelRoot) buildWireframe(modelRoot);
      for (const l of wireLines) l.visible = wireOn;
      wireMat.opacity = 0.95;
      xrayTarget = mode === "off" ? 0 : 1;
      dimTarget = mode === "off" ? 1 : 0.55;
    },
    setDriveMode(mode) {
      glowTarget = GLOW_BY_MODE[mode];
    },
    setRideHeight(steps) {
      heightTarget = steps * 0.035;
    },
    setPage(page) {
      const vehicle = page === "vehicle";
      groupXTarget = vehicle ? 0.4 : 0;
      groupZTarget = vehicle ? -2.2 : 0;
      rotTarget = VIEW_BY_PAGE[page];
      camYTarget = CAM_BY_PAGE[page].y;
      camAimYTarget = CAM_BY_PAGE[page].aimY;
      velocity = 0;
      posing = true;
    },
    setMiniView(rect) {
      miniBox = rect;
    },
  };
}
