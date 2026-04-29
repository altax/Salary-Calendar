/**
 * Find the nearest Mapillary street-level image to a lat/lng point.
 *
 * Two backends are tried in order:
 *   1. Graph API (`/images?bbox=...`) — requires the app to have the
 *      `read public data` scope enabled.
 *   2. Public vector tiles (`tiles.mapillary.com/.../mly1_public/...`) —
 *      works with ANY valid client token, no extra scopes needed.
 *
 * The vector-tile path is the reliable fallback: as long as the token
 * can fetch tiles (which the Mapillary JS Viewer also needs), we can
 * find a starting image without depending on Graph API permissions.
 */
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

export type FoundImage = {
  id: string;
  lat: number;
  lng: number;
  distance: number;
  isPano: boolean;
  source: "graph" | "tiles";
};

export function metersBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

function tileToLonLat(x: number, y: number, z: number) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}

async function findViaGraph(
  token: string,
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<FoundImage | null> {
  const dLat = radiusMeters / 111320;
  const dLng = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`;
  const url = `https://graph.mapillary.com/images?fields=id,computed_geometry,geometry,is_pano&bbox=${bbox}&limit=200`;
  const res = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      computed_geometry?: { coordinates: [number, number] };
      geometry?: { coordinates: [number, number] };
      is_pano?: boolean;
    }>;
  };
  const items = json.data ?? [];
  let best: FoundImage | null = null;
  for (const it of items) {
    const c = it.computed_geometry?.coordinates ?? it.geometry?.coordinates;
    if (!c) continue;
    const [ilng, ilat] = c;
    const d = metersBetween(lat, lng, ilat, ilng);
    const isPano = !!it.is_pano;
    const score = isPano ? d - 30 : d;
    const bestScore = best
      ? best.isPano
        ? best.distance - 30
        : best.distance
      : Infinity;
    if (score < bestScore) {
      best = {
        id: it.id,
        lat: ilat,
        lng: ilng,
        distance: d,
        isPano,
        source: "graph",
      };
    }
  }
  return best;
}

async function findViaTiles(
  token: string,
  lat: number,
  lng: number,
): Promise<FoundImage | null> {
  // z=14 is the smallest zoom at which the per-image `image` layer exists
  // in Mapillary's MVT pyramid. We fetch the centre tile + its 8 neighbours
  // so that points right next to a tile boundary aren't missed.
  const Z = 14;
  const { x: cx, y: cy } = lonLatToTile(lng, lat, Z);
  const reqs: Promise<{ tx: number; ty: number; buf: ArrayBuffer | null }>[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const tx = cx + dx;
      const ty = cy + dy;
      const url = `https://tiles.mapillary.com/maps/vtp/mly1_public/2/${Z}/${tx}/${ty}?access_token=${encodeURIComponent(token)}`;
      reqs.push(
        fetch(url).then(async (r) =>
          r.ok ? { tx, ty, buf: await r.arrayBuffer() } : { tx, ty, buf: null },
        ),
      );
    }
  }
  const tiles = await Promise.all(reqs);

  let best: FoundImage | null = null;
  for (const t of tiles) {
    if (!t.buf) continue;
    let vt: VectorTile;
    try {
      vt = new VectorTile(new Pbf(t.buf));
    } catch {
      continue;
    }
    const layer = vt.layers["image"];
    if (!layer) continue;
    const nw = tileToLonLat(t.tx, t.ty, Z);
    const se = tileToLonLat(t.tx + 1, t.ty + 1, Z);
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      let pt: { x: number; y: number } | undefined;
      try {
        const geom = f.loadGeometry();
        pt = geom[0]?.[0];
      } catch {
        continue;
      }
      if (!pt) continue;
      const ilng = nw.lon + (se.lon - nw.lon) * (pt.x / layer.extent);
      const ilat = nw.lat + (se.lat - nw.lat) * (pt.y / layer.extent);
      const d = metersBetween(lat, lng, ilat, ilng);
      const props = f.properties as Record<string, unknown>;
      const id = String(props.id ?? "");
      if (!id) continue;
      const isPano = !!props.is_pano;
      const score = isPano ? d - 30 : d;
      const bestScore = best
        ? best.isPano
          ? best.distance - 30
          : best.distance
        : Infinity;
      if (score < bestScore) {
        best = { id, lat: ilat, lng: ilng, distance: d, isPano, source: "tiles" };
      }
    }
  }
  return best;
}

export async function findNearestImage(
  token: string,
  lat: number,
  lng: number,
  radiusMeters = 800,
): Promise<FoundImage | null> {
  if (!token) throw new Error("VITE_MAPILLARY_TOKEN не задан");
  // Graph API first — if it works it gives us slightly more metadata,
  // and any wider area is a single HTTP call instead of 9 tile fetches.
  try {
    const viaGraph = await findViaGraph(token, lat, lng, radiusMeters);
    if (viaGraph) return viaGraph;
  } catch {
    // ignore, fall through to tiles
  }
  return findViaTiles(token, lat, lng);
}
