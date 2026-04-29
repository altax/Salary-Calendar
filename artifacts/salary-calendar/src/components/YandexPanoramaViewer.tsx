import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  fetchPanoByOid,
  pickZoomLevel,
  tileUrl,
  type LoadedPano,
  type LngLat,
} from "@/lib/yandex-pano";

type Props = {
  pano: LoadedPano;
  onNavigate: (next: LoadedPano) => void;
  onError?: (msg: string) => void;
};

/**
 * Equirectangular panorama viewer rendered via Three.js. The image is
 * stitched from 256×256 JPEG tiles served by Yandex (proxied through
 * our origin) and applied to an inverted sphere whose centre is the
 * camera. Mouse / touch drag yaws & pitches the camera; the wheel zooms
 * the FOV; clickable arrows on the ground walk the courier to the next
 * connected panorama.
 *
 * Key coordinate convention:
 *   World yaw is in degrees, measured clockwise from north. The image's
 *   centre column points to `pano.originYaw` in world coords, so to
 *   align the sphere with real geography we rotate the mesh by that
 *   offset on the Y axis.
 */
export function YandexPanoramaViewer({ pano, onNavigate, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tilesProgress, setTilesProgress] = useState({ done: 0, total: 0 });
  const [navigating, setNavigating] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

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

    // Sphere is rendered from the inside, so we flip its scale on X
    // (mirroring) instead of inverting normals. This keeps the texture
    // visually correct (text not mirrored) while letting the camera see
    // the inner surface.
    const sphereRadius = 100;
    const sphereGeometry = new THREE.SphereGeometry(sphereRadius, 64, 32);
    sphereGeometry.scale(-1, 1, 1);

    // Initial low-res placeholder (single neutral colour) so we can show
    // SOMETHING immediately while real tiles stream in.
    const placeholderTex = new THREE.DataTexture(
      new Uint8Array([20, 20, 24, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    placeholderTex.needsUpdate = true;
    const sphereMaterial = new THREE.MeshBasicMaterial({ map: placeholderTex });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    // Rotate the sphere so the image's centre column aligns with the
    // world-relative yaw it was captured at. After this, looking down
    // -Z (camera default) means looking north.
    sphere.rotation.y = THREE.MathUtils.degToRad(pano.originYaw);
    scene.add(sphere);

    // ── Pick the zoom level that best fits the device, then load tiles
    // into a single canvas which becomes the sphere texture.
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

    // Limited parallelism so we don't open dozens of concurrent connections.
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

    // ── Navigation arrows on the ground. Each thoroughfare gets a small
    // diamond sprite at its world yaw, sitting just below the horizon.
    const arrowsGroup = new THREE.Group();
    const arrowMeshes: Array<{ mesh: THREE.Mesh; oid: string }> = [];
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
      // Place the arrow on the ground (y = -8) at distance 16 from the
      // camera in the world yaw direction. Yaw 0 = north (-Z), 90 = east (+X).
      const yawRad = THREE.MathUtils.degToRad(tf.yaw);
      const r = 16;
      mesh.position.set(Math.sin(yawRad) * r, -8, -Math.cos(yawRad) * r);
      // Lay the arrow flat and rotate so the tip points away from camera.
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -yawRad;
      arrowsGroup.add(mesh);
      arrowMeshes.push({ mesh, oid: tf.oid });
    }
    scene.add(arrowsGroup);

    // ── Camera controls. Track yaw/pitch in radians.
    let yaw = 0;
    let pitch = 0;
    let fov = 75;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const updateCamera = () => {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      // Convert yaw/pitch to a look direction.
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
      // Sensitivity scales with current FOV so zoomed-in feels natural.
      const k = (fov / 75) * 0.005;
      yaw -= dx * k;
      pitch += dy * k;
      // Clamp pitch to avoid flipping.
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

    // Click → raycast for arrows.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      // Avoid treating drags as clicks.
      ndc.set(x, y);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(
        arrowMeshes.map((a) => a.mesh),
        false,
      );
      if (hits.length === 0) return;
      const found = arrowMeshes.find((a) => a.mesh === hits[0].object);
      if (!found || disposed) return;
      setNavigating(true);
      fetchPanoByOid(found.oid)
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

    // Resize observer keeps the renderer matched to its container.
    const ro = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    // Animation loop. Pulse arrow opacity so they're visibly clickable.
    let raf = 0;
    const tick = () => {
      const t = performance.now() * 0.003;
      const pulse = 0.7 + 0.3 * Math.sin(t);
      for (const a of arrowMeshes) {
        (a.mesh.material as THREE.MeshBasicMaterial).opacity = pulse;
      }
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
      arrowGeom.dispose();
      for (const a of arrowMeshes) {
        (a.mesh.material as THREE.MeshBasicMaterial).map?.dispose();
        (a.mesh.material as THREE.MeshBasicMaterial).dispose();
      }
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pano.imageId]);

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

/**
 * Generate a small canvas-based arrow texture for the navigation marker.
 * Returns a fresh THREE.Texture each call so each arrow can fade
 * independently.
 */
function makeArrowTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, size, size);
  // White arrow with subtle dark outline so it reads on any ground colour.
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
