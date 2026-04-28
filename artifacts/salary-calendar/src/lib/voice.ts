import type { RouteStep } from "@/lib/routing";

export type VoiceTier = "far" | "mid" | "near" | "now" | "arrival" | "rerouted";

const TIER_RADIUS_M: Record<VoiceTier, number> = {
  far: 250,
  mid: 80,
  near: 30,
  now: 0,
  arrival: 0,
  rerouted: 0,
};

// =====================================================================
// Voice selection
// =====================================================================
// Browser TTS quality varies wildly. Default eSpeak voices ("Russian") sound
// like a 1990s answering machine. We prefer high-quality cloud / OS voices in
// this order:
//   1. Explicit user choice (saved by name in localStorage)
//   2. Google русский (Chrome desktop / Android)
//   3. Microsoft Irina/Pavel/Daria/Dmitry (Windows / Edge)
//   4. Yandex (rare, but very good)
//   5. Apple "Yuri" / "Milena" (macOS / iOS)
//   6. anything ru-* that does NOT have "espeak" in the name
//   7. anything ru-*
// The cached pick is invalidated whenever the OS voice list changes.

const VOICE_PREF_KEY = "salary-calendar:voice:name:v1";

function loadPreferredName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(VOICE_PREF_KEY);
  } catch {
    return null;
  }
}

export function setPreferredVoiceName(name: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (name) window.localStorage.setItem(VOICE_PREF_KEY, name);
    else window.localStorage.removeItem(VOICE_PREF_KEY);
  } catch {}
  cachedRuVoice = undefined;
}

let cachedRuVoice: SpeechSynthesisVoice | null | undefined;

function isRu(v: SpeechSynthesisVoice): boolean {
  return v.lang === "ru-RU" || (v.lang ?? "").toLowerCase().startsWith("ru");
}

function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = (v.name ?? "").toLowerCase();
  // Higher = better.
  if (name.includes("espeak")) return 1;
  if (name.includes("google")) return 100;
  if (name.includes("microsoft") && (name.includes("natural") || name.includes("neural"))) return 95;
  if (name.includes("microsoft")) return 80;
  if (name.includes("yandex")) return 90;
  if (name.includes("milena") || name.includes("yuri") || name.includes("katya") || name.includes("дарья")) return 70;
  if (name.includes("siri")) return 60;
  return 30;
}

function pickRuVoice(): SpeechSynthesisVoice | null {
  if (cachedRuVoice !== undefined) return cachedRuVoice;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    cachedRuVoice = null;
    return null;
  }
  const voices = window.speechSynthesis.getVoices().filter(isRu);
  if (voices.length === 0) {
    cachedRuVoice = null;
    return null;
  }
  const preferred = loadPreferredName();
  if (preferred) {
    const exact = voices.find((v) => v.name === preferred);
    if (exact) {
      cachedRuVoice = exact;
      return exact;
    }
  }
  voices.sort((a, b) => scoreVoice(b) - scoreVoice(a));
  cachedRuVoice = voices[0];
  return voices[0];
}

export function listRuVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices().filter(isRu);
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedRuVoice = undefined;
  };
}

export type VoiceController = {
  speak(text: string): void;
  cancel(): void;
  setMuted(m: boolean): void;
  isMuted(): boolean;
  isSupported(): boolean;
};

export function createVoiceController(initialMuted = false): VoiceController {
  let muted = initialMuted;
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  return {
    speak(text: string) {
      if (!supported || muted) return;
      const synth = window.speechSynthesis;
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const v = pickRuVoice();
        u.lang = v?.lang || "ru-RU";
        // Slightly slower than default — most Russian TTS engines are too fast
        // and slur word endings, which is what makes them sound "robot-y".
        u.rate = 0.95;
        u.pitch = 1.0;
        u.volume = 1.0;
        if (v) u.voice = v;
        synth.speak(u);
      } catch {}
    },
    cancel() {
      if (!supported) return;
      try {
        window.speechSynthesis.cancel();
      } catch {}
    },
    setMuted(m: boolean) {
      muted = m;
      if (m) this.cancel();
    },
    isMuted() {
      return muted;
    },
    isSupported() {
      return supported;
    },
  };
}

// =====================================================================
// Russian pluralization
// =====================================================================
// Pick the right grammatical form for a count. Russian has three forms:
//   one  → 1, 21, 31, …  (but NOT 11)
//   few  → 2..4, 22..24, …  (but NOT 12..14)
//   many → 0, 5..20, 25..30, …
// Example: pluralRu(n, ["точка", "точки", "точек"]).
export function pluralRu(
  n: number,
  forms: [one: string, few: string, many: string],
): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

const TOCHKA: [string, string, string] = ["точка", "точки", "точек"];
const MINUTA: [string, string, string] = ["минута", "минуты", "минут"];
const MINUTU_ACC: [string, string, string] = ["минуту", "минуты", "минут"]; // accusative for "около"
const KILOMETR: [string, string, string] = ["километр", "километра", "километров"];
const METR: [string, string, string] = ["метр", "метра", "метров"];

// =====================================================================
// Maneuver vocabulary
// =====================================================================

const MODIFIER_RU: Record<string, string> = {
  left: "налево",
  right: "направо",
  straight: "прямо",
  uturn: "разворот",
  "slight left": "плавно налево",
  "slight right": "плавно направо",
  "sharp left": "резко налево",
  "sharp right": "резко направо",
};

const TYPE_RU: Record<string, (m?: string, name?: string) => string> = {
  turn: (m, name) =>
    `поверните ${MODIFIER_RU[m ?? ""] ?? ""}${name ? ` на ${name}` : ""}`,
  continue: (m, name) =>
    `продолжайте движение${m && MODIFIER_RU[m] ? ` ${MODIFIER_RU[m]}` : ""}${
      name ? ` по ${name}` : ""
    }`,
  merge: (m, name) =>
    `перестройтесь${m && MODIFIER_RU[m] ? ` ${MODIFIER_RU[m]}` : ""}${
      name ? ` на ${name}` : ""
    }`,
  "on ramp": (m, name) =>
    `выезжайте${m && MODIFIER_RU[m] ? ` ${MODIFIER_RU[m]}` : ""}${
      name ? ` на ${name}` : ""
    }`,
  "off ramp": (m, name) =>
    `съезжайте${m && MODIFIER_RU[m] ? ` ${MODIFIER_RU[m]}` : ""}${
      name ? ` на ${name}` : ""
    }`,
  fork: (m, name) =>
    `держитесь ${MODIFIER_RU[m ?? ""] ?? "по развилке"}${name ? ` на ${name}` : ""}`,
  "end of road": (m, name) =>
    `в конце дороги ${MODIFIER_RU[m ?? ""] ?? ""}${name ? ` на ${name}` : ""}`,
  "new name": (_m, name) => (name ? `продолжайте по ${name}` : "продолжайте"),
  roundabout: (_m, _name) => "на круговом движении",
  rotary: (_m, _name) => "на круговом движении",
  "roundabout turn": (_m, _name) => "на кругу",
  "exit roundabout": (_m, name) =>
    `съезжайте с круга${name ? ` на ${name}` : ""}`,
  "exit rotary": (_m, name) => `съезжайте с круга${name ? ` на ${name}` : ""}`,
  arrive: () => "вы прибыли",
  depart: (_m, name) => (name ? `двигайтесь по ${name}` : "поехали"),
};

export function maneuverInstruction(step: RouteStep | null): string {
  if (!step) return "";
  const type = step.maneuver.type;
  const mod = step.maneuver.modifier;
  const name = step.name?.trim() || step.ref?.trim() || "";
  const fn = TYPE_RU[type];
  if (fn) {
    const txt = fn(mod, name).trim().replace(/\s+/g, " ");
    return txt.charAt(0).toUpperCase() + txt.slice(1);
  }
  if (mod && MODIFIER_RU[mod]) {
    const txt = `${MODIFIER_RU[mod]}${name ? ` на ${name}` : ""}`;
    return txt.charAt(0).toUpperCase() + txt.slice(1);
  }
  return name ? `Продолжайте по ${name}` : "Продолжайте движение";
}

export function maneuverArrow(step: RouteStep | null): string {
  if (!step) return "•";
  const t = step.maneuver.type;
  if (t === "arrive") return "◉";
  if (t === "depart") return "↑";
  if (t === "roundabout" || t === "rotary" || t === "roundabout turn") return "⟳";
  const m = step.maneuver.modifier;
  switch (m) {
    case "left":
      return "←";
    case "right":
      return "→";
    case "slight left":
      return "↖";
    case "slight right":
      return "↗";
    case "sharp left":
      return "↩";
    case "sharp right":
      return "↪";
    case "uturn":
      return "↶";
    case "straight":
      return "↑";
    default:
      return "↑";
  }
}

export function formatDistanceRu(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "сейчас";
  if (m < 50) return "сейчас";
  if (m < 1000) {
    const rounded = Math.round(m / 10) * 10;
    return `через ${rounded} ${pluralRu(rounded, METR)}`;
  }
  const km = m / 1000;
  if (km < 10) {
    // "через 1,5 километра", "через 2,3 километра", "через 5,0 километров"
    const rounded = Math.round(km * 10) / 10;
    const intPart = Math.trunc(rounded);
    const word =
      Math.abs(rounded - intPart) > 0.05
        ? KILOMETR[1] // fractional → "километра"
        : pluralRu(intPart, KILOMETR);
    return `через ${rounded.toFixed(1).replace(".", ",")} ${word}`;
  }
  const whole = Math.round(km);
  return `через ${whole} ${pluralRu(whole, KILOMETR)}`;
}

export function buildVoicePrompt(
  step: RouteStep | null,
  tier: VoiceTier,
  distanceM: number,
): string {
  if (!step) return "";
  if (tier === "arrival") return "Вы прибыли. Доставка.";
  if (tier === "rerouted") return "Маршрут перестроен.";
  const instr = maneuverInstruction(step);
  if (tier === "now") return instr;
  return `${formatDistanceRu(distanceM)} ${instr.toLowerCase()}`;
}

export const VOICE_TIER_RADIUS = TIER_RADIUS_M;

export class StepAnnouncer {
  private lastTier: Map<string, VoiceTier> = new Map();
  private lastStepKey: string | null = null;

  reset() {
    this.lastTier.clear();
    this.lastStepKey = null;
  }

  considerAnnounce(
    voice: VoiceController,
    step: RouteStep | null,
    distanceToManeuverM: number,
  ): VoiceTier | null {
    if (!step) return null;
    const key = `${step.maneuver.location[0].toFixed(5)},${step.maneuver.location[1].toFixed(5)}|${step.maneuver.type}|${step.maneuver.modifier ?? ""}`;
    if (this.lastStepKey !== key) {
      this.lastStepKey = key;
    }
    let tier: VoiceTier | null = null;
    if (distanceToManeuverM <= TIER_RADIUS_M.near) tier = "near";
    else if (distanceToManeuverM <= TIER_RADIUS_M.mid) tier = "mid";
    else if (distanceToManeuverM <= TIER_RADIUS_M.far) tier = "far";
    if (!tier) return null;
    const order: VoiceTier[] = ["far", "mid", "near"];
    const prev = this.lastTier.get(key);
    if (prev && order.indexOf(prev) >= order.indexOf(tier)) return null;
    this.lastTier.set(key, tier);
    voice.speak(buildVoicePrompt(step, tier, distanceToManeuverM));
    return tier;
  }

  announceArrival(voice: VoiceController) {
    voice.speak(buildVoicePrompt(null as any, "arrival", 0) || "Вы прибыли.");
  }

  announceRerouted(voice: VoiceController) {
    voice.speak("Маршрут перестроен.");
  }
}

export class StopAnnouncer {
  private announcedFar = new Set<string>();
  private announcedNear = new Set<string>();

  reset(): void {
    this.announcedFar.clear();
    this.announcedNear.clear();
  }

  considerAnnounce(
    voice: VoiceController,
    stopId: string,
    label: string,
    distanceM: number,
  ): void {
    if (distanceM <= 80 && !this.announcedNear.has(stopId)) {
      this.announcedNear.add(stopId);
      this.announcedFar.add(stopId);
      voice.speak(`${label} — рядом, готовьтесь к остановке.`);
      return;
    }
    if (distanceM <= 400 && !this.announcedFar.has(stopId)) {
      this.announcedFar.add(stopId);
      const m = Math.round(distanceM / 10) * 10;
      voice.speak(`${label} — через ${m} ${pluralRu(m, METR)}.`);
    }
  }
}

function kmPhrase(totalKm: number): string {
  if (totalKm < 1) {
    const m = Math.round(totalKm * 1000);
    return `${m} ${pluralRu(m, METR)}`;
  }
  const rounded = Math.round(totalKm * 10) / 10;
  const intPart = Math.trunc(rounded);
  const word =
    Math.abs(rounded - intPart) > 0.05
      ? KILOMETR[1]
      : pluralRu(intPart, KILOMETR);
  return `${rounded.toFixed(1).replace(".", ",")} ${word}`;
}

function minPhrase(totalSec: number): string {
  const m = Math.max(1, Math.round(totalSec / 60));
  // "около" takes accusative — and for 1 it's "около минуты" (genitive sg),
  // for 2..4 "около двух/трёх/четырёх минут", for 5+ "около пяти минут".
  // The pattern that reads correctly for all: "около N минута/минуты/минут"
  // is `pluralRu(m, MINUTU_ACC)` which gives минуту/минуты/минут.
  // BUT for the single-minute case the natural Russian reading is
  // "около одной минуты". We special-case 1.
  if (m === 1) return "около минуты";
  return `около ${m} ${pluralRu(m, MINUTU_ACC)}`;
}

export function announceRouteBuilt(
  voice: VoiceController,
  totalKm: number,
  totalSec: number,
  stopsCount: number,
): void {
  voice.speak(
    `Маршрут построен. ${stopsCount} ${pluralRu(stopsCount, TOCHKA)}, ${kmPhrase(totalKm)}, ${minPhrase(totalSec)}.`,
  );
}

export function announceOfflineFallbackRoute(voice: VoiceController): void {
  voice.speak("Маршрут построен по прямой — нет связи.");
}

export function announceStopDelivered(
  voice: VoiceController,
  remaining: number,
): void {
  if (remaining <= 0) {
    voice.speak("Заказ доставлен. Все точки выполнены, строю маршрут до депо.");
  } else {
    voice.speak(
      `Заказ доставлен. Осталось ${remaining} ${pluralRu(remaining, TOCHKA)}.`,
    );
  }
}

export function announceStopUndone(voice: VoiceController): void {
  voice.speak("Отмена. Возврат к предыдущей точке.");
}

export function announceReturningToDepot(voice: VoiceController): void {
  voice.speak("Все заказы доставлены. Маршрут до депо построен.");
}

export function announceShiftFinished(voice: VoiceController): void {
  voice.speak("Вы прибыли в депо. Смена окончена. Хорошего отдыха.");
}
