// Service-worker controller for offline tile + OSRM cache management.
// All bookkeeping is via postMessage; the SW (`public/sw.js`) does the actual
// caching with cache-first strategies and a high-concurrency prefetch worker.

const TILE_TEMPLATES = [
  "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
  "https://b.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
  "https://c.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
  "https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png",
  "https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
  "https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png",
];

export type TileBounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

function lonToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      Math.pow(2, z),
  );
}

export function tilesForBounds(
  bounds: TileBounds,
  zooms: number[],
  templates: string[] = TILE_TEMPLATES,
): string[] {
  const out: string[] = [];
  for (const z of zooms) {
    const x0 = lonToTileX(bounds.minLng, z);
    const x1 = lonToTileX(bounds.maxLng, z);
    const y0 = latToTileY(bounds.maxLat, z);
    const y1 = latToTileY(bounds.minLat, z);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
        for (const tpl of templates) {
          out.push(tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
        }
      }
    }
  }
  return out;
}

export function boundsAround(
  center: { lat: number; lng: number },
  radiusKm: number,
): TileBounds {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((center.lat * Math.PI) / 180));
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLng: center.lng - dLng,
    maxLng: center.lng + dLng,
  };
}

export const SPB_BOUNDS: TileBounds = {
  minLat: 59.74,
  maxLat: 60.1,
  minLng: 30.05,
  maxLng: 30.65,
};

export type PrefetchProgress = {
  done: number;
  failed: number;
  total: number;
  finished: boolean;
};

export function prefetchTiles(
  urls: string[],
  onProgress?: (p: PrefetchProgress) => void,
): Promise<PrefetchProgress> {
  return new Promise((resolve) => {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
      const result = { done: 0, failed: urls.length, total: urls.length, finished: true };
      onProgress?.(result);
      resolve(result);
      return;
    }
    const handler = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === "PREFETCH_PROGRESS") {
        onProgress?.({
          done: data.done,
          failed: data.failed,
          total: data.total,
          finished: false,
        });
      } else if (data.type === "PREFETCH_COMPLETE") {
        navigator.serviceWorker.removeEventListener("message", handler);
        const result = {
          done: data.done,
          failed: data.failed,
          total: data.total,
          finished: true,
        };
        onProgress?.(result);
        resolve(result);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    navigator.serviceWorker.controller.postMessage({
      type: "PREFETCH_TILES",
      urls,
    });
  });
}

export function prefetchRoutingUrls(urls: string[]): void {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage({
    type: "PREFETCH_ROUTES",
    urls,
  });
}

export function readCacheInfo(): Promise<{ tiles: number; routes: number }> {
  return new Promise((resolve) => {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
      resolve({ tiles: 0, routes: 0 });
      return;
    }
    const handler = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === "CACHE_INFO") {
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve({ tiles: data.tiles ?? 0, routes: data.routes ?? 0 });
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    navigator.serviceWorker.controller.postMessage({ type: "CACHE_INFO" });
    // safety timeout
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", handler);
      resolve({ tiles: 0, routes: 0 });
    }, 3000);
  });
}

export function clearTileCache(): void {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage({ type: "CLEAR_TILES" });
}
