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

let cachedRuVoice: SpeechSynthesisVoice | null | undefined;

function pickRuVoice(): SpeechSynthesisVoice | null {
  if (cachedRuVoice !== undefined) return cachedRuVoice;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    cachedRuVoice = null;
    return null;
  }
  const voices = window.speechSynthesis.getVoices();
  const ru =
    voices.find((v) => v.lang === "ru-RU") ||
    voices.find((v) => v.lang?.toLowerCase().startsWith("ru")) ||
    null;
  cachedRuVoice = ru;
  return ru;
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
        u.lang = "ru-RU";
        u.rate = 1.0;
        u.pitch = 1.0;
        u.volume = 1.0;
        const v = pickRuVoice();
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
    return `через ${rounded} метров`;
  }
  const km = m / 1000;
  if (km < 10) return `через ${km.toFixed(1).replace(".", ",")} километра`;
  return `через ${Math.round(km)} километров`;
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
