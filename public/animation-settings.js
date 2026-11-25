export const DEFAULT_EVENT_ANIMATION = Object.freeze({
  fps: 60,
  trailLength: 350,
  orbitDuration: 4700,
  orbSize: 7.5,
  glowIntensity: 1.10,
  eventDuration: 25000
});

const RANGES = Object.freeze({
  fps: [12, 120],
  trailLength: [80, 700],
  orbitDuration: [1500, 12000],
  orbSize: [2, 16],
  glowIntensity: [0.35, 2.5],
  eventDuration: [3000, 180000]
});

function clamp(value, min, max, fallback, integer = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const result = Math.min(max, Math.max(min, n));
  return integer ? Math.round(result) : result;
}

export function normalizeEventAnimation(settings = {}) {
  const base = DEFAULT_EVENT_ANIMATION;
  return {
    fps: clamp(settings.fps, ...RANGES.fps, base.fps, true),
    trailLength: clamp(settings.trailLength, ...RANGES.trailLength, base.trailLength, true),
    orbitDuration: clamp(settings.orbitDuration, ...RANGES.orbitDuration, base.orbitDuration, true),
    orbSize: clamp(settings.orbSize, ...RANGES.orbSize, base.orbSize),
    glowIntensity: clamp(settings.glowIntensity, ...RANGES.glowIntensity, base.glowIntensity),
    eventDuration: clamp(settings.eventDuration, ...RANGES.eventDuration, base.eventDuration, true)
  };
}

export async function loadEventAnimationSettings() {
  try {
    const response = await fetch('/api/overlay-settings', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return normalizeEventAnimation(data?.eventAnimation ?? {});
  } catch (error) {
    console.warn('Réglages animation indisponibles, profil intégré utilisé:', error);
    return { ...DEFAULT_EVENT_ANIMATION };
  }
}

export function applyAnimationUrlOverrides(settings, params = new URLSearchParams(location.search)) {
  const base = normalizeEventAnimation(settings);
  return normalizeEventAnimation({
    ...base,
    fps: params.has('eventFps') || params.has('fps') ? params.get('eventFps') ?? params.get('fps') : base.fps,
    trailLength: params.has('trailLength') ? params.get('trailLength') : base.trailLength,
    orbitDuration: params.has('orbitDuration') ? params.get('orbitDuration') : base.orbitDuration,
    orbSize: params.has('orbSize') ? params.get('orbSize') : base.orbSize,
    glowIntensity: params.has('glowIntensity') ? params.get('glowIntensity') : base.glowIntensity,
    eventDuration: params.has('eventDuration') ? params.get('eventDuration') : base.eventDuration
  });
}
