// Where things are on the Ledger map. One projection for the land dots and the
// cities, so a city can never drift off its coast.

/** The part of the world the map shows. Antarctica and the far north are cut: nobody donates from there. */
export const VIEW = { lonLeft: -168, lonRight: 180, latTop: 84, latBottom: -57 };

/** Plate carrée stretched to the map's box: lon/lat -> 0..1 of the box. */
export function project(lon: number, lat: number): { x: number; y: number } {
  return {
    x: (lon - VIEW.lonLeft) / (VIEW.lonRight - VIEW.lonLeft),
    y: (VIEW.latTop - lat) / (VIEW.latTop - VIEW.latBottom),
  };
}

/** The inverse of `project`: 0..1 of the box -> lon/lat. */
export function unproject(x: number, y: number): { lon: number; lat: number } {
  return { lon: VIEW.lonLeft + x * (VIEW.lonRight - VIEW.lonLeft), lat: VIEW.latTop - y * (VIEW.latTop - VIEW.latBottom) };
}

export interface LonLat {
  lon: number;
  lat: number;
}

// lon, lat, ISO country. Rounded to a tenth of a degree: a dot on a world map needs no more.
const CITIES: Record<string, [number, number, string]> = {
  amsterdam: [4.9, 52.4, "NL"], athens: [23.7, 38, "GR"], atlanta: [-84.4, 33.7, "US"], auckland: [174.8, -36.8, "NZ"], austin: [-97.7, 30.3, "US"],
  bangalore: [77.6, 13, "IN"], bangkok: [100.5, 13.8, "TH"], barcelona: [2.2, 41.4, "ES"], beijing: [116.4, 39.9, "CN"], berlin: [13.4, 52.5, "DE"],
  bogota: [-74.1, 4.7, "CO"], boston: [-71.1, 42.4, "US"], brisbane: [153, -27.5, "AU"], brussels: [4.4, 50.8, "BE"], bucharest: [26.1, 44.4, "RO"],
  budapest: [19, 47.5, "HU"], "buenos aires": [-58.4, -34.6, "AR"], busan: [129.1, 35.2, "KR"], cairo: [31.2, 30, "EG"], "cape town": [18.4, -33.9, "ZA"],
  chicago: [-87.6, 41.9, "US"], cleveland: [-81.7, 41.5, "US"], cologne: [7, 50.9, "DE"], columbus: [-83, 40, "US"], copenhagen: [12.6, 55.7, "DK"],
  dallas: [-96.8, 32.8, "US"], delhi: [77.2, 28.6, "IN"], denver: [-105, 39.7, "US"], detroit: [-83, 42.3, "US"], dubai: [55.3, 25.2, "AE"],
  dublin: [-6.3, 53.3, "IE"], edinburgh: [-3.2, 56, "GB"], frankfurt: [8.7, 50.1, "DE"], fukuoka: [130.4, 33.6, "JP"], geneva: [6.1, 46.2, "CH"],
  hamburg: [10, 53.6, "DE"], hanoi: [105.8, 21, "VN"], helsinki: [24.9, 60.2, "FI"], "hong kong": [114.2, 22.3, "HK"], honolulu: [-157.9, 21.3, "US"],
  houston: [-95.4, 29.8, "US"], istanbul: [29, 41, "TR"], jakarta: [106.8, -6.2, "ID"], johannesburg: [28, -26.2, "ZA"], "kansas city": [-94.6, 39.1, "US"],
  kyiv: [30.5, 50.5, "UA"], kyoto: [135.8, 35, "JP"], lagos: [3.4, 6.5, "NG"], "las vegas": [-115.1, 36.2, "US"], lima: [-77, -12, "PE"],
  lisbon: [-9.1, 38.7, "PT"], london: [-0.1, 51.5, "GB"], "los angeles": [-118.2, 34.1, "US"], lyon: [4.8, 45.8, "FR"], madrid: [-3.7, 40.4, "ES"],
  manchester: [-2.2, 53.5, "GB"], manila: [121, 14.6, "PH"], melbourne: [145, -37.8, "AU"], "mexico city": [-99.1, 19.4, "MX"], miami: [-80.2, 25.8, "US"],
  milan: [9.2, 45.5, "IT"], minneapolis: [-93.3, 45, "US"], montreal: [-73.6, 45.5, "CA"], mumbai: [72.9, 19.1, "IN"], munich: [11.6, 48.1, "DE"],
  nagoya: [136.9, 35.2, "JP"], nairobi: [36.8, -1.3, "KE"], naples: [14.3, 40.9, "IT"], nashville: [-86.8, 36.2, "US"], "new york": [-74, 40.7, "US"],
  oslo: [10.8, 59.9, "NO"], osaka: [135.5, 34.7, "JP"], ottawa: [-75.7, 45.4, "CA"], paris: [2.4, 48.9, "FR"], perth: [115.9, -32, "AU"],
  philadelphia: [-75.2, 40, "US"], phoenix: [-112.1, 33.4, "US"], pittsburgh: [-80, 40.4, "US"], portland: [-122.7, 45.5, "US"], prague: [14.4, 50.1, "CZ"],
  "rio de janeiro": [-43.2, -22.9, "BR"], riyadh: [46.7, 24.7, "SA"], rome: [12.5, 41.9, "IT"], rotterdam: [4.5, 51.9, "NL"], "san diego": [-117.2, 32.7, "US"],
  "san francisco": [-122.4, 37.8, "US"], santiago: [-70.7, -33.5, "CL"], "sao paulo": [-46.6, -23.6, "BR"], sapporo: [141.4, 43.1, "JP"], seattle: [-122.3, 47.6, "US"],
  sendai: [140.9, 38.3, "JP"], seoul: [127, 37.6, "KR"], shanghai: [121.5, 31.2, "CN"], singapore: [103.8, 1.4, "SG"], stockholm: [18.1, 59.3, "SE"],
  sydney: [151.2, -33.9, "AU"], taipei: [121.6, 25, "TW"], "tel aviv": [34.8, 32.1, "IL"], tokyo: [139.7, 35.7, "JP"], toronto: [-79.4, 43.7, "CA"],
  vancouver: [-123.1, 49.3, "CA"], vienna: [16.4, 48.2, "AT"], warsaw: [21, 52.2, "PL"], "washington": [-77, 38.9, "US"], wellington: [174.8, -41.3, "NZ"],
  yokohama: [139.6, 35.4, "JP"], zurich: [8.5, 47.4, "CH"],
};

// A donor from a town the table does not know still lands in their country.
const COUNTRIES: Record<string, [number, number]> = {
  AE: [54, 24], AR: [-64, -34], AT: [14.5, 47.5], AU: [134, -25], BD: [90, 24], BE: [4.5, 50.8], BG: [25, 43], BR: [-53, -10], CA: [-96, 56], CH: [8.2, 46.8],
  CL: [-71, -33], CN: [104, 35], CO: [-74, 4], CZ: [15.5, 49.8], DE: [10.4, 51.2], DK: [10, 56], EE: [25.5, 58.7], EG: [30, 27], ES: [-3.7, 40], FI: [26, 64],
  FR: [2.3, 46.6], GB: [-2, 54], GR: [22, 39], HK: [114.2, 22.3], HR: [16, 45.5], HU: [19.5, 47.2], ID: [114, -2], IE: [-8, 53.4], IL: [35, 31.5], IN: [79, 22],
  IS: [-18.5, 65], IT: [12.6, 42.8], JP: [138, 36.5], KE: [38, 0], KR: [127.8, 36.5], LT: [24, 55.3], LV: [25, 57], MA: [-6, 32], MX: [-102, 23.6], MY: [102, 4],
  NG: [8, 9.5], NL: [5.3, 52.2], NO: [9, 61], NZ: [172, -41], PE: [-75, -9.5], PH: [122, 12.5], PK: [70, 30], PL: [19.4, 52], PT: [-8, 39.6], RO: [25, 45.9],
  SA: [45, 24], SE: [16, 62], SG: [103.8, 1.4], SI: [14.8, 46.1], SK: [19.5, 48.7], TH: [101, 15], TR: [35, 39], TW: [121, 23.7], UA: [31, 49], US: [-98, 39.5],
  VN: [106, 16], ZA: [25, -29],
};

const key = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** The city if the table knows it in that country, else the country's middle, else null: no dot beats a wrong dot. */
export function locate(city: string | null | undefined, country: string | null | undefined): LonLat | null {
  const iso = country?.trim().toUpperCase() || null;
  const c = city ? CITIES[key(city)] : undefined;
  if (c && (!iso || c[2] === iso)) return { lon: c[0], lat: c[1] };
  const fallback = iso ? COUNTRIES[iso] : undefined;
  return fallback ? { lon: fallback[0], lat: fallback[1] } : null;
}
