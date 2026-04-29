import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  fetchPanoByOid,
  pickZoomLevel,
  tileUrl,
  type LoadedPano,
  type LngLat,
} from "@/lib/yandex-pano";

/**
 * A 3D ground spot painted on the asphalt at (bearing, distance) from
 * the panorama centre. Used to draw the route the courier should follow.
 */
export type GroundDot = {
  /** World heading in degrees (clockwise from north). */
  bearingDeg: number;
  /** Distance in metres from the panorama centre. */
  distanceM: number;
  color: string;
  /** Diameter in metres (default 0.6). */
  sizeM?: number;
};

/**
 * A vertical pin marker (e.g. next delivery, next maneuver). Renders a
 * narrow rectangle standing on the ground at (bearing, distance).
 */
export type GroundPin = {
  bearingDeg: number;
  distanceM: number;
  color: string;
  label?: string;
  /** Height in metres (default 4). */
  heightM?: number;
};

type Props = {
  pano: LoadedPano;
  onNavigate: (next: LoadedPano) => void;
  onError?: (msg: string) => void;
  /**
   * If provided, the camera yaw is set to this world heading every time
   * the panorama changes. The user can still drag freely after the
   * initial snap. Useful for "windshield camera" mode while driving.
   */
  initialYawDegrees?: number;
  /** Continuous trail of ground dots to render (e.g. route polyline). */
  routeDots?: GroundDot[];
  /** Vertical pin markers (e.g. delivery destinations). */
  pins?: GroundPin[];
  /** Show built-in arrows that walk the user to neighbouring panoramas. */
  showThoroughfareArrows?: boolean;
};

// Eye height we assume Yandex's panorama camera was at (≈ car roof). All
// ground geometry is placed at y = -EYE_HEIGHT_M so it lands on the
// asphalt visible in the photo.
const EYE_HEIGHT_M = 2;

/**
 * Equirectangular panorama viewer rendered via Three.js. The image is
 * stitched from 256×256 JPEG tiles served by Yandex (proxied through our
 * origin) and applied to an inverted sphere whose centre is the camera.
 *
 * Drag yaws / pitches the camera; the wheel zooms the FOV; optional
 * arrows on the ground let the user click to walk to a neighbouring
 * panorama.
 *
 * Coordinate convention:
 *   World yaw is in degrees clockwise from north. The image's centre
 *   column points to `pano.originYaw` in world coords, so we rotate the
 *   sphere mesh by that offset on the Y axis. After this, "camera yaw =
 *   world yaw": setting the camera to look at yaw = 90° points it east.
 *   Ground geometry placed at (sin(yaw)·d, -2, -cos(yaw)·d) ends up at
 *   the right pixel on the asphalt.
 */
export function YandexPanoramaViewer({
  pano,
  onNavigate,
  onError,
  initialYawDegrees,
  routeDots,
  pins,
  showThoroughfareArrows = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tilesProgress, setTilesProgress] = useState({ done: 0, total: 0 });
  const [navigating, setNavigating] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  // Ref bag so we can mutate scene contents from non-effect callbacks
  // without tearing the renderer down.
  const sceneRef = useRef<{
    scene: THREE.Scene;
    decorationsGroup: THREE.Group;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "WebGL недоступен в этом браузере";
      setGlError(msg);
      onError?.(`Не удалось создать WebGL: ${msg}`);
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    camera.position.set(0, 0, 0);

    const sphereRadius = 100;
    const sphereGeometry = new THREE.SphereGeometry(sphereRadius, 64, 32);
    sphereGeometry.scale(-1, 1, 1);

    const placeholderTex = new THREE.DataTexture(
      new Uint8Array([20, 20, 24, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    placeholderTex.needsUpdate = true;
    const sphereMaterial = new THREE.MeshBasicMaterial({ map: placeholderTex });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere.rotation.y = THREE.MathUtils.degToRad(pano.originYaw);
    scene.add(sphere);

    // Tile streaming → CanvasTexture.
    const targetWidth =
      Math.min(4096, Math.max(2048, container.clientWidth * window.devicePixelRatio * 4));
    const zoom = pickZoomLevel(pano.zooms, targetWidth);
    const cols = Math.ceil(zoom.width / pano.tilePixelSize);
    const rows = Math.ceil(zoom.height / pano.tilePixelSize);

    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = zoom.width;
    fullCanvas.height = zoom.height;
    const ctx = fullCanvas.getContext("2d");
    if (!ctx) {
      onError?.("Не удалось создать canvas для панорамы");
      return;
    }
    ctx.fillStyle = "#202024";
    ctx.fillRect(0, 0, zoom.width, zoom.height);

    const fullTex = new THREE.CanvasTexture(fullCanvas);
    fullTex.colorSpace = THREE.SRGBColorSpace;
    fullTex.minFilter = THREE.LinearFilter;
    fullTex.magFilter = THREE.LinearFilter;
    fullTex.generateMipmaps = false;
    sphereMaterial.map = fullTex;
    sphereMaterial.needsUpdate = true;

    const total = cols * rows;
    setTilesProgress({ done: 0, total });
    let done = 0;

    const loadTile = (cx: number, cy: number) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          ctx.drawImage(img, cx * pano.tilePixelSize, cy * pano.tilePixelSize);
          fullTex.needsUpdate = true;
          done += 1;
          setTilesProgress({ done, total });
          resolve();
        };
        img.onerror = () => {
          done += 1;
          setTilesProgress({ done, total });
          resolve();
        };
        img.src = tileUrl(pano.imageId, zoom.level, cx, cy);
      });

    const queue: Array<[number, number]> = [];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) queue.push([cx, cy]);
    }
    const concurrency = 6;
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        if (disposed) break;
        await loadTile(next[0], next[1]);
      }
    });
    Promise.all(workers).catch((e) => onError?.(String(e)));

    // ── Decorations group: arrows, route dots, pins. We rebuild this
    // group whenever those props change without re-running the heavy
    // sphere-loading effect.
    const decorationsGroup = new THREE.Group();
    scene.add(decorationsGroup);

    sceneRef.current = { scene, decorationsGroup };

    // ── Camera controls.
    let yaw = initialYawDegrees != null
      ? THREE.MathUtils.degToRad(initialYawDegrees)
      : 0;
    let pitch = 0;
    let fov = 75;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const updateCamera = () => {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      const cosP = Math.cos(pitch);
      const dir = new THREE.Vector3(
        Math.sin(yaw) * cosP,
        Math.sin(pitch),
        -Math.cos(yaw) * cosP,
      );
      camera.lookAt(dir);
    };
    updateCamera();

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const k = (fov / 75) * 0.005;
      yaw -= dx * k;
      pitch += dy * k;
      pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
      updateCamera();
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      fov = Math.max(25, Math.min(95, fov + delta * 4));
      updateCamera();
    };

    // Click → raycast for clickable arrows in the decorations group.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ndc.set(x, y);
      raycaster.setFromCamera(ndc, camera);
      const targets: THREE.Object3D[] = [];
      decorationsGroup.traverse((obj) => {
        if (obj.userData?.clickOid) targets.push(obj);
      });
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length === 0) return;
      const oid = hits[0].object.userData?.clickOid as string | undefined;
      if (!oid || disposed) return;
      setNavigating(true);
      fetchPanoByOid(oid)
        .then((next) => {
          if (next && !disposed) onNavigate(next);
          setNavigating(false);
        })
        .catch((err) => {
          setNavigating(false);
          onError?.(`Не удалось перейти: ${err}`);
        });
    };

    const dom = renderer.domElement;
    dom.style.touchAction = "none";
    dom.style.cursor = "grab";
    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerup", onPointerUp);
    dom.addEventListener("pointercancel", onPointerUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("click", onClick);

    const ro = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    let raf = 0;
    const tick = () => {
      const t = performance.now() * 0.003;
      const pulse = 0.7 + 0.3 * Math.sin(t);
      decorationsGroup.traverse((obj) => {
        if (obj.userData?.pulse) {
          const m = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          m.opacity = pulse;
        }
      });
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("pointercancel", onPointerUp);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("click", onClick);
      sphereGeometry.dispose();
      sphereMaterial.dispose();
      fullTex.dispose();
      placeholderTex.dispose();
      decorationsGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
      sceneRef.current = null;
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pano.imageId]);

  // ── Decoration sync. Rebuild arrows / dots / pins whenever the props
  // change, without disturbing the heavy sphere texture pipeline.
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    const { decorationsGroup } = ctx;

    // Tear down whatever was there.
    while (decorationsGroup.children.length > 0) {
      const obj = decorationsGroup.children[0] as THREE.Mesh;
      decorationsGroup.remove(obj);
      obj.geometry?.dispose?.();
      const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose?.();
    }

    // Route trail: small flat yellow disks on the asphalt.
    if (routeDots && routeDots.length > 0) {
      const baseGeom = new THREE.CircleGeometry(0.5, 24);
      for (const d of routeDots) {
        const yawRad = THREE.MathUtils.degToRad(d.bearingDeg);
        const r = Math.min(80, Math.max(1.5, d.distanceM));
        const x = Math.sin(yawRad) * r;
        const z = -Math.cos(yawRad) * r;
        const mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(d.color),
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const size = (d.sizeM ?? 0.6) * Math.max(0.6, r / 8);
        const mesh = new THREE.Mesh(baseGeom, mat);
        mesh.scale.setScalar(size);
        mesh.position.set(x, -EYE_HEIGHT_M + 0.05, z);
        mesh.rotation.x = -Math.PI / 2;
        decorationsGroup.add(mesh);
      }
    }

    // Vertical pins for delivery destinations / depot.
    if (pins && pins.length > 0) {
      for (const p of pins) {
        const yawRad = THREE.MathUtils.degToRad(p.bearingDeg);
        const r = Math.min(80, Math.max(2, p.distanceM));
        const x = Math.sin(yawRad) * r;
        const z = -Math.cos(yawRad) * r;
        const h = p.heightM ?? 4;
        // The pin: a thin cylinder + a sphere head, tinted to the pin colour.
        const stickGeom = new THREE.CylinderGeometry(0.08, 0.08, h, 12);
        const stickMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(p.color),
          transparent: true,
          opacity: 0.95,
        });
        const stick = new THREE.Mesh(stickGeom, stickMat);
        stick.position.set(x, -EYE_HEIGHT_M + h / 2, z);
        decorationsGroup.add(stick);

        const headGeom = new THREE.SphereGeometry(0.6, 16, 12);
        const headMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(p.color),
          transparent: true,
          opacity: 0.95,
        });
        const head = new THREE.Mesh(headGeom, headMat);
        head.position.set(x, -EYE_HEIGHT_M + h, z);
        head.userData.pulse = true;
        decorationsGroup.add(head);
      }
    }

    // Built-in thoroughfare arrows (free-explore mode).
    if (showThoroughfareArrows) {
      const arrowGeom = new THREE.PlaneGeometry(8, 8);
      for (const tf of pano.thoroughfares) {
        const arrowTex = makeArrowTexture();
        const arrowMat = new THREE.MeshBasicMaterial({
          map: arrowTex,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(arrowGeom, arrowMat);
        const yawRad = THREE.MathUtils.degToRad(tf.yaw);
        const r = 16;
        mesh.position.set(Math.sin(yawRad) * r, -EYE_HEIGHT_M, -Math.cos(yawRad) * r);
        mesh.rotation.x = -Math.PI / 2;
        mesh.rotation.z = -yawRad;
        mesh.userData.clickOid = tf.oid;
        mesh.userData.pulse = true;
        decorationsGroup.add(mesh);
      }
    }
  }, [pano.imageId, routeDots, pins, showThoroughfareArrows, pano.thoroughfares]);

  const tilePct =
    tilesProgress.total === 0
      ? 0
      : Math.round((tilesProgress.done / tilesProgress.total) * 100);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />
      {glError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-center px-6">
          <div className="text-sm uppercase tracking-[0.2em] text-yellow-300">
            нет WebGL
          </div>
          <div className="mt-2 text-[11px] text-foreground/70 max-w-md font-mono">
            {glError}
          </div>
          <div className="mt-3 text-[11px] text-foreground/60 max-w-md">
            Включи аппаратное ускорение в браузере или открой панораму на
            Яндекс.Картах.
          </div>
        </div>
      )}
      {tilesProgress.total > 0 && tilesProgress.done < tilesProgress.total && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-background/80 border border-border text-[10px] uppercase tracking-[0.18em] font-mono pointer-events-none">
          панорама {tilePct}% · {tilesProgress.done}/{tilesProgress.total}
        </div>
      )}
      {navigating && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-background/80 border border-border text-[10px] uppercase tracking-[0.18em] font-mono pointer-events-none">
          переход…
        </div>
      )}
    </div>
  );
}

function makeArrowTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, size, size);
  g.beginPath();
  g.moveTo(size / 2, size * 0.1);
  g.lineTo(size * 0.85, size * 0.85);
  g.lineTo(size / 2, size * 0.65);
  g.lineTo(size * 0.15, size * 0.85);
  g.closePath();
  g.fillStyle = "rgba(255,255,255,0.92)";
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = "rgba(0,0,0,0.6)";
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export type { LngLat };
