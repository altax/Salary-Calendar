/**
 * Helpers for talking to the Yandex Panoramas private JSON API via our
 * server-side proxy (`/_api/yandex-pano`, `/_tiles/yandex-pano`).
 *
 * The panorama API is undocumented but stable enough that several
 * open-source projects rely on it; we mirror its response shape here as
 * narrowly as the viewer needs.
 */

export type LngLat = { lng: number; lat: number };

export type YandexPanoZoom = {
  level: number;
  width: number;
  height: number;
};

export type YandexPanoThoroughfare = {
  /** World-relative direction [yawDegrees, pitchDegrees], 0° = north. */
  Direction: [number, number];
  Connection: { name?: string; href?: string };
};

export type YandexPanoHistorical = {
  timestamp: number;
  Connection: {
    oid: string;
    name: string;
    href?: string;
    Point?: { coordinates: [number, number, number] };
  };
};

export type YandexPanoData = {
  status: string;
  data?: {
    Data: {
      panoramaId: string;
      timestamp: number;
      Point: { coordinates: [number, number, number] };
      EquirectangularProjection?: {
        /** [yawDegrees, pitchDegrees] world heading of image centre. */
        Origin: [number, number];
      };
      Images: {
        imageId: string;
        Zooms: YandexPanoZoom[];
        Tiles: { width: number; height: number };
      };
    };
    Annotation?: {
      Thoroughfares?: YandexPanoThoroughfare[];
      HistoricalPanoramas?: YandexPanoHistorical[];
    };
  };
};

export type LoadedPano = {
  panoramaId: string;
  imageId: string;
  position: LngLat;
  /** Heading in degrees the image's centre column points to (0° = north). */
  originYaw: number;
  /** Pitch in degrees of the image's centre row (0° = horizon). */
  originPitch: number;
  zooms: YandexPanoZoom[];
  tilePixelSize: number;
  thoroughfares: Array<{
    /** World yaw in degrees, 0° = north, 90° = east. */
    yaw: number;
    pitch: number;
    /** OID for /_api/yandex-pano?oid=... lookup of the next panorama. */
    oid: string;
  }>;
  historical: Array<{ year: string; oid: string; timestamp: number }>;
  /** Captured timestamp (unix seconds). */
  timestamp: number;
};

function parseOidFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const m = href.match(/[?&]oid=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function transform(raw: YandexPanoData): LoadedPano | null {
  if (raw.status !== "success" || !raw.data) return null;
  const d = raw.data.Data;
  if (!d?.Images?.imageId) return null;
  const [originYaw, originPitch] = d.EquirectangularProjection?.Origin ?? [0, 0];
  const [lng, lat] = d.Point.coordinates;
  const thoroughfares = (raw.data.Annotation?.Thoroughfares ?? [])
    .map((t) => {
      const oid = parseOidFromHref(t.Connection?.href);
      if (!oid) return null;
      return { yaw: t.Direction[0], pitch: t.Direction[1], oid };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const historical = (raw.data.Annotation?.HistoricalPanoramas ?? []).map((h) => ({
    year: h.Connection.name,
    oid: h.Connection.oid,
    timestamp: h.timestamp,
  }));
  return {
    panoramaId: d.panoramaId,
    imageId: d.Images.imageId,
    position: { lng, lat },
    originYaw,
    originPitch,
    zooms: d.Images.Zooms,
    tilePixelSize: d.Images.Tiles.width,
    thoroughfares,
    historical,
    timestamp: d.timestamp,
  };
}

export async function fetchPanoByPoint(p: LngLat): Promise<LoadedPano | null> {
  const url = `/_api/yandex-pano?ll=${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Yandex pano lookup failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as YandexPanoData;
  return transform(json);
}

export async function fetchPanoByOid(oid: string): Promise<LoadedPano | null> {
  const url = `/_api/yandex-pano?oid=${encodeURIComponent(oid)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Yandex pano lookup failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as YandexPanoData;
  return transform(json);
}

export function tileUrl(imageId: string, zoom: number, x: number, y: number) {
  return `/_tiles/yandex-pano/${imageId}/${zoom}.${x}.${y}`;
}

/** Pick a sensible zoom level given the available device pixel width. */
export function pickZoomLevel(zooms: YandexPanoZoom[], targetWidthPx: number) {
  // Zoom levels are sorted from highest detail (level 0) to lowest.
  // Find the smallest zoom that still has width >= target.
  const sorted = [...zooms].sort((a, b) => a.width - b.width);
  for (const z of sorted) {
    if (z.width >= targetWidthPx) return z;
  }
  return sorted[sorted.length - 1];
}
