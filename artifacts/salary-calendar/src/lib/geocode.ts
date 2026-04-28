export type GeocodeResult = {
  lat: number;
  lng: number;
  displayName: string;
  shortName: string;
};

const NOMINATIM_URL = "https://nominatim.openstreetmap.org";

const SPB_VIEWBOX = "29.4,60.1,30.8,59.7";

export async function searchAddress(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  const params = new URLSearchParams({
    q: trimmed,
    format: "jsonv2",
    addressdetails: "1",
    limit: "6",
    "accept-language": "ru",
    viewbox: SPB_VIEWBOX,
    bounded: "1",
  });
  const res = await fetch(`${NOMINATIM_URL}/search?${params.toString()}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    address?: Record<string, string>;
  }>;
  return data.map((r) => {
    const a = r.address || {};
    const street = a.road || a.pedestrian || a.footway || "";
    const num = a.house_number || "";
    const district =
      a.suburb || a.city_district || a.neighbourhood || a.quarter || "";
    const short = [street, num].filter(Boolean).join(", ") || district || r.display_name.split(",")[0];
    return {
      lat: Number(r.lat),
      lng: Number(r.lon),
      displayName: r.display_name,
      shortName: short,
    };
  });
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: "jsonv2",
    "accept-language": "ru",
    zoom: "18",
    addressdetails: "1",
  });
  try {
    const res = await fetch(`${NOMINATIM_URL}/reverse?${params.toString()}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      display_name?: string;
      address?: Record<string, string>;
    };
    const a = data.address || {};
    const street = a.road || a.pedestrian || a.footway || "";
    const num = a.house_number || "";
    const district =
      a.suburb || a.city_district || a.neighbourhood || a.quarter || "";
    const short = [street, num].filter(Boolean).join(", ") || district;
    return short || data.display_name || null;
  } catch {
    return null;
  }
}
