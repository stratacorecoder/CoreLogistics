import {
  CELL_META,
  minutesBetween,
  ZONE_META,
  type LayoutCell,
  type LocationStatus,
  type SiteLayout,
} from "@corelogistics/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MapCell, MapLens } from "./SiteMap.js";

export interface SiteMap3DProps {
  layout: SiteLayout;
  locations?: LocationStatus[];
  selectedKey?: string | null;
  highlight?: Iterable<string>;
  lens?: MapLens;
  now?: number;
  onCellClick?: (cell: MapCell, locations: LocationStatus[]) => void;
}

type CameraPreset = "iso" | "top" | "yard" | "racks";

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = document.documentElement;
    const sync = () => setDark(node.getAttribute("data-theme") === "dark");
    const obs = new MutationObserver(sync);
    obs.observe(node, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function makeBadgeSprite(text: string, bg: string, fg = "#ffffff"): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "700 22px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
  ctx.font = font;
  const padX = 18;
  const textW = Math.ceil(ctx.measureText(text).width);
  canvas.width = Math.max(84, textW + padX * 2);
  canvas.height = 44;

  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 18);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.stroke();

  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = canvas.width / canvas.height;
  const h = 0.34;
  sprite.scale.set(h * aspect, h, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function heatColorFor(
  cell: MapCell,
  occupied: number,
  capacity: number,
  since: string | null,
  now: number,
): number | null {
  if (cell.kind === "yard_slot" || cell.kind === "dock_door") {
    if (occupied === 0 || !since) return null;
    const mins = minutesBetween(since, now);
    if (mins >= 90) return 0xdc2626;
    if (mins >= 45) return 0xea580c;
    if (mins >= 15) return 0xeab308;
    return 0x0ea5e9;
  }
  if (cell.kind === "rack" || cell.kind === "staging" || cell.kind === "sort_lane") {
    if (capacity <= 0 || occupied === 0) return null;
    const r = occupied / capacity;
    if (r >= 0.9) return 0xdc2626;
    if (r >= 0.7) return 0xea580c;
    if (r >= 0.35) return 0xeab308;
    return 0x0ea5e9;
  }
  return null;
}

function createTruckMesh(trailerColor: number, cabColor: number, facingRad: number, plate?: string): THREE.Group {
  const g = new THREE.Group();

  // Chassis
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.06, 0.78),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 }),
  );
  chassis.position.set(0, 0.08, 0);
  chassis.castShadow = true;
  g.add(chassis);

  // Wheels
  const wheelGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.06, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.85 });
  for (const z of [-0.26, 0.02, 0.28]) {
    for (const x of [-0.21, 0.21]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, 0.065, z);
      g.add(w);
    }
  }

  // Trailer cargo box
  const trailer = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.34, 0.54),
    new THREE.MeshStandardMaterial({ color: trailerColor, roughness: 0.4, metalness: 0.1 }),
  );
  trailer.position.set(0, 0.28, -0.1);
  trailer.castShadow = true;
  trailer.receiveShadow = true;
  g.add(trailer);

  // Cab
  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.27, 0.22),
    new THREE.MeshStandardMaterial({ color: cabColor, roughness: 0.35, metalness: 0.2 }),
  );
  cab.position.set(0, 0.24, 0.29);
  cab.castShadow = true;
  g.add(cab);

  // Windshield
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.38, 0.1, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.1, metalness: 0.5 }),
  );
  glass.position.set(0, 0.28, 0.405);
  g.add(glass);

  g.rotation.y = facingRad;

  if (plate) {
    const sprite = makeBadgeSprite(plate, "#0f172a");
    sprite.position.set(0, 0.72, 0);
    g.add(sprite);
  }
  return g;
}

function createRackMesh(
  levels: number,
  occupied: number,
  capacity: number,
  cargoColor: number,
  isFull: boolean,
): THREE.Group {
  const g = new THREE.Group();
  const lvlCount = Math.max(1, Math.min(6, levels));
  const shelfStep = 0.28;
  const totalH = lvlCount * shelfStep + 0.08;

  const postMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.45, metalness: 0.65 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.5, metalness: 0.35 });
  const palletMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.8 });
  const boxMat = new THREE.MeshStandardMaterial({
    color: isFull ? 0xdc2626 : cargoColor,
    roughness: 0.45,
    metalness: 0.08,
  });

  // 4 corner steel uprights
  const postGeo = new THREE.BoxGeometry(0.045, totalH, 0.045);
  for (const px of [-0.36, 0.36]) {
    for (const pz of [-0.3, 0.3]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(px, totalH / 2, pz);
      post.castShadow = true;
      g.add(post);
    }
  }

  // Shelf beams & pallets per level
  const beamGeo = new THREE.BoxGeometry(0.76, 0.032, 0.64);
  const ratio = capacity > 0 ? Math.min(1, occupied / capacity) : 0;
  const totalSlots = lvlCount * 2;
  const filledSlots = occupied > 0 ? Math.max(1, Math.round(ratio * totalSlots)) : 0;

  let slotIndex = 0;
  for (let l = 0; l < lvlCount; l++) {
    const y = 0.06 + l * shelfStep;
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(0, y, 0);
    beam.receiveShadow = true;
    g.add(beam);

    for (const sx of [-0.18, 0.18]) {
      if (slotIndex < filledSlots) {
        const pallet = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.48), palletMat);
        pallet.position.set(sx, y + 0.03, 0);
        g.add(pallet);

        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.17, 0.44), boxMat);
        crate.position.set(sx, y + 0.13, 0);
        crate.castShadow = true;
        crate.receiveShadow = true;
        g.add(crate);
      }
      slotIndex += 1;
    }
  }

  return g;
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) {
      for (const m of mat) m.dispose();
    } else if (mat) {
      const tex = (mat as THREE.SpriteMaterial).map;
      if (tex) tex.dispose();
      mat.dispose();
    }
  });
}

export function SiteMap3D({
  layout,
  locations = [],
  selectedKey,
  highlight,
  lens = "standard",
  now = Date.now(),
  onCellClick,
}: SiteMap3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dark = useDarkTheme();
  const [webglError, setWebglError] = useState(false);
  const [hoveredText, setHoveredText] = useState<string | null>(null);

  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const worldGroupRef = useRef<THREE.Group | null>(null);
  const flowAnimRef = useRef<Array<{ mesh: THREE.Mesh; curve: THREE.QuadraticBezierCurve3; phase: number }>>([]);
  const onCellClickRef = useRef(onCellClick);
  onCellClickRef.current = onCellClick;

  const cellMetaMap = useMemo(() => {
    const byKey = new Map<string, MapCell>();
    for (let y = 0; y < layout.rows; y++) {
      for (let x = 0; x < layout.cols; x++) {
        byKey.set(`${x}:${y}`, { x, y, kind: "empty" });
      }
    }
    for (const c of layout.cells) byKey.set(`${c.x}:${c.y}`, c);
    return byKey;
  }, [layout]);

  const locsByCell = useMemo(() => {
    const m = new Map<string, LocationStatus[]>();
    for (const l of locations) {
      const k = `${l.x}:${l.y}`;
      const list = m.get(k) ?? [];
      list.push(l);
      m.set(k, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.level - b.level);
    return m;
  }, [locations]);

  const hot = useMemo(() => new Set(highlight ?? []), [highlight]);

  const applyPreset = (preset: CameraPreset) => {
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    if (!cam || !ctrl) return;
    const span = Math.max(layout.cols, layout.rows, 10);
    ctrl.target.set(0, 0, 0);
    if (preset === "iso") {
      cam.position.set(span * 0.65, span * 0.72, span * 0.78);
    } else if (preset === "top") {
      cam.position.set(0, span * 1.12, 0.01);
    } else if (preset === "yard") {
      cam.position.set(-span * 0.55, span * 0.34, span * 0.52);
    } else {
      cam.position.set(span * 0.45, span * 0.38, span * 0.48);
    }
    ctrl.update();
  };

  // Initialize Three.js WebGLRenderer, Scene, Lights, OrbitControls, Raycasting
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setWebglError(true);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const span = Math.max(layout.cols, layout.rows, 10);
    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 200);
    camera.position.set(span * 0.65, span * 0.72, span * 0.78);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 4;
    controls.maxDistance = span * 2.4;
    controlsRef.current = controls;

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x334155, 0.95);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.15);
    dir.position.set(span * 0.6, span * 1.1, span * 0.55);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = span * 4;
    const d = span * 0.75;
    dir.shadow.camera.left = -d;
    dir.shadow.camera.right = d;
    dir.shadow.camera.top = d;
    dir.shadow.camera.bottom = -d;
    scene.add(dir);

    const worldGroup = new THREE.Group();
    scene.add(worldGroup);
    worldGroupRef.current = worldGroup;

    const resize = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // Raycasting for hover & click
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPt: { x: number; y: number } | null = null;

    const hitCellKey = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(worldGroup.children, true);
      for (const hit of hits) {
        let cur: THREE.Object3D | null = hit.object;
        while (cur && cur !== worldGroup) {
          if (typeof cur.userData?.cellKey === "string") {
            return cur.userData.cellKey as string;
          }
          cur = cur.parent;
        }
      }
      return null;
    };

    const onPointerDown = (e: PointerEvent) => {
      downPt = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downPt) return;
      const moved = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
      downPt = null;
      if (moved > 6) return;
      const key = hitCellKey(e.clientX, e.clientY);
      if (!key) return;
      const cell = cellMetaMap.get(key);
      if (!cell || cell.kind === "empty") return;
      const locs = locsByCell.get(key) ?? [];
      onCellClickRef.current?.(cell, locs);
    };
    const onPointerMove = (e: PointerEvent) => {
      const key = hitCellKey(e.clientX, e.clientY);
      if (!key) {
        renderer.domElement.style.cursor = "grab";
        setHoveredText(null);
        return;
      }
      const cell = cellMetaMap.get(key);
      if (!cell || cell.kind === "empty") {
        renderer.domElement.style.cursor = "grab";
        setHoveredText(null);
        return;
      }
      const locs = locsByCell.get(key) ?? [];
      const code = cell.kind === "rack" && locs[0] ? locs[0].code.replace(/-\d+$/, "") : locs[0]?.code ?? cell.label ?? "";
      const occ = locs.reduce((n, l) => n + l.occupied, 0);
      const cap = locs.reduce((n, l) => n + l.capacity, 0);
      const ref = locs.flatMap((l) => l.refs)[0];
      renderer.domElement.style.cursor = locs.length ? "pointer" : "grab";
      setHoveredText(
        [CELL_META[cell.kind].label, code, ref || (cap ? `${occ}/${cap} HU` : "")]
          .filter(Boolean)
          .join(" · "),
      );
    };

    const onPointerLeave = () => {
      renderer.domElement.style.cursor = "grab";
      setHoveredText(null);
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      for (const item of flowAnimRef.current) {
        const u = (t * 0.35 + item.phase) % 1;
        item.mesh.position.copy(item.curve.getPoint(u));
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();
      disposeObject3D(worldGroup);
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      sceneRef.current = null;
      worldGroupRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
    };
  }, [cellMetaMap, locsByCell, layout.cols, layout.rows]);

  // Sync scene background with light/dark theme
  useEffect(() => {
    if (sceneRef.current) {
      sceneRef.current.background = new THREE.Color(dark ? 0x0b1220 : 0xeef3fa);
    }
  }, [dark]);

  // Rebuild 3D geometry whenever layout, locations, lens, or selection changes
  useEffect(() => {
    const group = worldGroupRef.current;
    if (!group) return;
    disposeObject3D(group);
    group.clear();
    flowAnimRef.current = [];

    const cx = (layout.cols - 1) / 2;
    const cz = (layout.rows - 1) / 2;
    const toWorld = (x: number, y: number) => ({ wx: x - cx, wz: y - cz });

    // Ground slab
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(layout.cols + 0.8, 0.14, layout.rows + 0.8),
      new THREE.MeshStandardMaterial({ color: dark ? 0x162032 : 0xdbe3ee, roughness: 0.9 }),
    );
    ground.position.set(0, -0.07, 0);
    ground.receiveShadow = true;
    group.add(ground);

    // Subtle grid lines
    const grid = new THREE.GridHelper(
      Math.max(layout.cols, layout.rows) + 0.5,
      Math.max(layout.cols, layout.rows),
      dark ? 0x334155 : 0x94a3b8,
      dark ? 0x1e293b : 0xcbd5e1,
    );
    grid.position.y = 0.004;
    group.add(grid);

    const tileGeo = new THREE.BoxGeometry(0.94, 0.03, 0.94);

    // Helper to orient trucks/docks toward adjacent road
    const roadFacing = (x: number, y: number): number => {
      if (cellMetaMap.get(`${x}:${y + 1}`)?.kind === "road") return 0;
      if (cellMetaMap.get(`${x}:${y - 1}`)?.kind === "road") return Math.PI;
      if (cellMetaMap.get(`${x + 1}:${y}`)?.kind === "road") return Math.PI / 2;
      if (cellMetaMap.get(`${x - 1}:${y}`)?.kind === "road") return -Math.PI / 2;
      return 0;
    };

    const busyGates: LayoutCell[] = [];
    const busyYard: LayoutCell[] = [];
    const busyDocks: LayoutCell[] = [];
    const busyMid: LayoutCell[] = [];
    const busyRacks: LayoutCell[] = [];

    for (const cell of layout.cells) {
      if (cell.kind === "empty") continue;
      const key = `${cell.x}:${cell.y}`;
      const locs = locsByCell.get(key) ?? [];
      const occupied = locs.reduce((n, l) => n + l.occupied, 0);
      const capacity = locs.reduce((n, l) => n + l.capacity, 0);
      const since = locs.find((l) => l.since)?.since ?? null;
      const ref = locs.flatMap((l) => l.refs)[0];
      const isSelected = selectedKey === key;
      const isHot = locs.some((l) => hot.has(l.id));
      const heatCol = lens === "heat" ? heatColorFor(cell, occupied, capacity, since, now) : null;
      const { wx, wz } = toWorld(cell.x, cell.y);

      const cellGroup = new THREE.Group();
      cellGroup.position.set(wx, 0, wz);
      cellGroup.userData.cellKey = key;

      if (cell.kind === "road") {
        const road = new THREE.Mesh(
          tileGeo,
          new THREE.MeshStandardMaterial({ color: dark ? 0x1e293b : 0x475569, roughness: 0.92 }),
        );
        road.position.y = 0.015;
        road.receiveShadow = true;
        cellGroup.add(road);
      } else if (cell.kind === "aisle") {
        const aisle = new THREE.Mesh(
          tileGeo,
          new THREE.MeshStandardMaterial({ color: dark ? 0x263246 : 0xe2e8f0, roughness: 0.88 }),
        );
        aisle.position.y = 0.015;
        aisle.receiveShadow = true;
        cellGroup.add(aisle);
      } else if (cell.kind === "wall") {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(0.96, 0.56, 0.96),
          new THREE.MeshStandardMaterial({ color: dark ? 0x334155 : 0x1e293b, roughness: 0.7 }),
        );
        wall.position.y = 0.28;
        wall.castShadow = true;
        wall.receiveShadow = true;
        cellGroup.add(wall);
      } else if (cell.kind === "office") {
        const bldg = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.78, 0.92),
          new THREE.MeshStandardMaterial({ color: 0x5856d6, roughness: 0.25, metalness: 0.15 }),
        );
        bldg.position.y = 0.39;
        bldg.castShadow = true;
        cellGroup.add(bldg);
        if (cell.label) {
          const sp = makeBadgeSprite(cell.label, "#4338ca");
          sp.position.set(0, 1.05, 0);
          cellGroup.add(sp);
        }
      } else if (cell.kind === "gate") {
        busyGates.push(cell);
        const pad = new THREE.Mesh(
          tileGeo,
          new THREE.MeshStandardMaterial({ color: 0x0066cc, roughness: 0.6 }),
        );
        pad.position.y = 0.02;
        cellGroup.add(pad);
        const pillarGeo = new THREE.BoxGeometry(0.1, 0.65, 0.1);
        const pillarMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.4, roughness: 0.35 });
        for (const px of [-0.36, 0.36]) {
          const p = new THREE.Mesh(pillarGeo, pillarMat);
          p.position.set(px, 0.325, 0);
          p.castShadow = true;
          cellGroup.add(p);
        }
        const arch = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.12, 0.16), pillarMat);
        arch.position.set(0, 0.68, 0);
        arch.castShadow = true;
        cellGroup.add(arch);
        const sp = makeBadgeSprite(locs[0]?.code ?? cell.label ?? "GATE", "#0066cc");
        sp.position.set(0, 1.02, 0);
        cellGroup.add(sp);
      } else if (cell.kind === "yard_slot") {
        if (occupied > 0) busyYard.push(cell);
        const pad = new THREE.Mesh(
          tileGeo,
          new THREE.MeshStandardMaterial({
            color: heatCol ?? (occupied > 0 ? 0xf59e0b : dark ? 0x1e293b : 0xf1f5f9),
            roughness: 0.82,
          }),
        );
        pad.position.y = 0.018;
        pad.receiveShadow = true;
        cellGroup.add(pad);
        if (occupied > 0) {
          const truck = createTruckMesh(heatCol ?? 0xf97316, 0xf8fafc, roadFacing(cell.x, cell.y), ref);
          cellGroup.add(truck);
        }
      } else if (cell.kind === "dock_door") {
        if (occupied > 0) busyDocks.push(cell);
        const apron = new THREE.Mesh(
          new THREE.BoxGeometry(0.94, 0.1, 0.94),
          new THREE.MeshStandardMaterial({
            color: heatCol ?? (occupied > 0 ? 0x16a34a : 0x157a34),
            roughness: 0.65,
          }),
        );
        apron.position.y = 0.05;
        apron.receiveShadow = true;
        cellGroup.add(apron);

        // Bay arch
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.5 });
        const arch = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.52, 0.14), frameMat);
        arch.position.set(0, 0.31, -0.34);
        arch.castShadow = true;
        cellGroup.add(arch);

        if (occupied > 0) {
          const truck = createTruckMesh(heatCol ?? 0x22c55e, 0xe2e8f0, roadFacing(cell.x, cell.y), ref);
          truck.position.y = 0.06;
          cellGroup.add(truck);
        }
      } else if (cell.kind === "staging" || cell.kind === "sort_lane") {
        if (occupied > 0) busyMid.push(cell);
        const baseColor = cell.kind === "staging" ? 0xc2410c : 0x5856d6;
        const pad = new THREE.Mesh(
          tileGeo,
          new THREE.MeshStandardMaterial({ color: heatCol ?? baseColor, roughness: 0.65 }),
        );
        pad.position.y = 0.025;
        pad.receiveShadow = true;
        cellGroup.add(pad);

        if (occupied > 0) {
          const stacks = Math.min(4, Math.max(1, Math.ceil((occupied / Math.max(1, capacity)) * 4)));
          for (let i = 0; i < stacks; i++) {
            const crate = new THREE.Mesh(
              new THREE.BoxGeometry(0.32, 0.18, 0.32),
              new THREE.MeshStandardMaterial({ color: heatCol ?? 0xfbbf24, roughness: 0.5 }),
            );
            crate.position.set(i % 2 === 0 ? -0.18 : 0.18, 0.13 + Math.floor(i / 2) * 0.19, 0);
            crate.castShadow = true;
            cellGroup.add(crate);
          }
        }
      } else if (cell.kind === "rack") {
        if (occupied > 0) busyRacks.push(cell);
        const pad = new THREE.Mesh(
          tileGeo,
          new THREE.MeshStandardMaterial({ color: dark ? 0x1e1b4b : 0xede9fe, roughness: 0.85 }),
        );
        pad.position.y = 0.015;
        pad.receiveShadow = true;
        cellGroup.add(pad);

        const zoneCol = cell.zone ? parseInt(ZONE_META[cell.zone].color.slice(1), 16) : 0x7c3aed;
        const rack = createRackMesh(
          cell.levels ?? 3,
          occupied,
          capacity,
          heatCol ?? zoneCol,
          capacity > 0 && occupied >= capacity && lens !== "heat",
        );
        cellGroup.add(rack);
      }

      if (isSelected || isHot) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.42, 0.5, 4),
          new THREE.MeshBasicMaterial({
            color: isHot ? 0x38bdf8 : 0x007aff,
            side: THREE.DoubleSide,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.rotation.z = Math.PI / 4;
        ring.position.y = 0.055;
        cellGroup.add(ring);
      }

      group.add(cellGroup);
    }

    // 3D Animated Flow Arcs when lens === "flow"
    if (lens === "flow") {
      const nearest = (src: LayoutCell, targets: LayoutCell[]) => {
        let best: LayoutCell | null = null;
        let bestD = Infinity;
        for (const t of targets) {
          const d = Math.hypot(t.x - src.x, t.y - src.y);
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        return best;
      };
      const addArc = (a: LayoutCell, b: LayoutCell, colorHex: number, phase: number) => {
        const p1 = toWorld(a.x, a.y);
        const p2 = toWorld(b.x, b.y);
        const v1 = new THREE.Vector3(p1.wx, 0.35, p1.wz);
        const v2 = new THREE.Vector3(p2.wx, 0.35, p2.wz);
        const mid = new THREE.Vector3((v1.x + v2.x) / 2, 1.3 + v1.distanceTo(v2) * 0.14, (v1.z + v2.z) / 2);
        const curve = new THREE.QuadraticBezierCurve3(v1, mid, v2);
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 24, 0.035, 8, false),
          new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.72 }),
        );
        group.add(tube);
        const orb = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        group.add(orb);
        flowAnimRef.current.push({ mesh: orb, curve, phase });
      };

      let idx = 0;
      for (const y of busyYard.slice(0, 6)) {
        if (busyGates[0]) addArc(busyGates[0], y, 0xf59e0b, (idx++ * 0.23) % 1);
        const d = nearest(y, busyDocks);
        if (d) addArc(y, d, 0x22c55e, (idx++ * 0.23) % 1);
      }
      for (const d of busyDocks.slice(0, 6)) {
        const m = nearest(d, busyMid);
        if (m) addArc(d, m, 0x22c55e, (idx++ * 0.23) % 1);
      }
      for (const m of busyMid.slice(0, 6)) {
        const r = nearest(m, busyRacks);
        if (r) addArc(m, r, 0x38bdf8, (idx++ * 0.23) % 1);
      }
    }
  }, [cellMetaMap, dark, hot, layout, lens, locsByCell, now, selectedKey]);

  if (webglError) {
    return (
      <div className="empty">
        3D WebGL context unavailable on this device. Switch off 3D to use the 2D floorplan.
      </div>
    );
  }

  return (
    <div className="sitemap-3d-shell">
      <div ref={hostRef} className="sitemap-3d-host" />
      <div className="sitemap-3d-hud">
        <div className="segmented" role="group" aria-label="3D camera presets">
          {(["iso", "top", "yard", "racks"] as const).map((preset) => (
            <button key={preset} type="button" onClick={() => applyPreset(preset)}>
              {preset === "iso" ? "Iso" : preset === "top" ? "Top" : preset === "yard" ? "Yard" : "Racks"}
            </button>
          ))}
        </div>
      </div>
      {hoveredText ? <div className="sitemap-3d-tooltip">{hoveredText}</div> : null}
      <div className="sitemap-3d-hint">Drag to orbit · Scroll to zoom · Click rack or truck to inspect</div>
    </div>
  );
}
