import fs from "node:fs";
import path from "node:path";

export interface EventAnimationConfig {
  fps: number;
  trailLength: number;
  orbitDuration: number;
  orbSize: number;
  glowIntensity: number;
  eventDuration: number;
}

export interface AppConfig {
  twitch: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    channelLogin: string;
    accessToken: string;
    refreshToken: string;
  };
  youtube: {
    enabled: boolean;
    apiKey: string;
    videoId: string;
    oauthClientId: string;
    oauthClientSecret: string;
    oauthAccessToken: string;
    oauthRefreshToken: string;
    oauthExpiresAt: number;
  };
  overlay: {
    eventAnimation: EventAnimationConfig;
    eventAnimationRevision: number;
  };
}

export interface PublicConfig {
  twitch: {
    enabled: boolean;
    clientId: string;
    channelLogin: string;
    hasClientSecret: boolean;
    authenticated: boolean;
  };
  youtube: {
    enabled: boolean;
    videoId: string;
    hasApiKey: boolean;
    oauthClientId: string;
    hasOauthClientSecret: boolean;
    sendAuthenticated: boolean;
  };
  overlay: {
    eventAnimation: EventAnimationConfig;
    eventAnimationRevision: number;
  };
}

// Profil V2.5.8 validé visuellement dans /chat puis reproduit à l'identique dans /feed.
// C'est la référence globale tant qu'une Browser Source ne la surcharge pas via son URL.
export const DEFAULT_EVENT_ANIMATION: EventAnimationConfig = {
  fps: 60,
  trailLength: 350,
  orbitDuration: 4700,
  orbSize: 7.5,
  glowIntensity: 1.10,
  eventDuration: 25000
};

const EVENT_ANIMATION_REVISION = 2;

const defaultConfig: AppConfig = {
  twitch: {
    enabled: false,
    clientId: "",
    clientSecret: "",
    channelLogin: "",
    accessToken: "",
    refreshToken: ""
  },
  youtube: {
    enabled: false,
    apiKey: "",
    videoId: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthAccessToken: "",
    oauthRefreshToken: "",
    oauthExpiresAt: 0
  },
  overlay: {
    eventAnimation: { ...DEFAULT_EVENT_ANIMATION },
    eventAnimationRevision: EVENT_ANIMATION_REVISION
  }
};

export class ConfigStore {
  private value: AppConfig;

  constructor(private readonly filePath: string) {
    const loaded = this.load();
    this.value = loaded.config;
    if (loaded.shouldPersist) this.save();
  }

  private load(): { config: AppConfig; shouldPersist: boolean } {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { config: structuredClone(defaultConfig), shouldPersist: false };
      }

      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const rawAnimation = raw.overlay?.eventAnimation ?? {};
      let eventAnimation: EventAnimationConfig = {
        ...DEFAULT_EVENT_ANIMATION,
        ...rawAnimation
      };
      const previousRevision = Number(raw.overlay?.eventAnimationRevision ?? 0);
      let shouldPersist = previousRevision !== EVENT_ANIMATION_REVISION;

      // Certaines V2.5.x pouvaient sauvegarder les minimums 2 px / 0,35 alors que
      // /chat gardait encore en mémoire l'ancien profil 7,5 / 1,10. On ne migre
      // automatiquement QUE cette signature connue, afin de ne pas écraser un vrai
      // réglage personnalisé de l'utilisateur.
      if (previousRevision < EVENT_ANIMATION_REVISION && isKnownBrokenLegacyAnimation(eventAnimation)) {
        console.log("Migration animation V2.5.8 : ancien profil incohérent remplacé par le profil visuel validé.");
        eventAnimation = { ...DEFAULT_EVENT_ANIMATION };
        shouldPersist = true;
      }

      return {
        config: {
          twitch: { ...defaultConfig.twitch, ...(raw.twitch ?? {}) },
          youtube: { ...defaultConfig.youtube, ...(raw.youtube ?? {}) },
          overlay: {
            eventAnimation,
            eventAnimationRevision: EVENT_ANIMATION_REVISION
          }
        },
        shouldPersist
      };
    } catch (error) {
      console.warn("Impossible de lire la configuration, valeurs par défaut utilisées:", error);
      return { config: structuredClone(defaultConfig), shouldPersist: false };
    }
  }

  get(): AppConfig {
    return structuredClone(this.value);
  }

  publicView(): PublicConfig {
    return {
      twitch: {
        enabled: this.value.twitch.enabled,
        clientId: this.value.twitch.clientId,
        channelLogin: this.value.twitch.channelLogin,
        hasClientSecret: Boolean(this.value.twitch.clientSecret),
        authenticated: Boolean(this.value.twitch.accessToken)
      },
      youtube: {
        enabled: this.value.youtube.enabled,
        videoId: this.value.youtube.videoId,
        hasApiKey: Boolean(this.value.youtube.apiKey),
        oauthClientId: this.value.youtube.oauthClientId,
        hasOauthClientSecret: Boolean(this.value.youtube.oauthClientSecret),
        sendAuthenticated: Boolean(this.value.youtube.oauthAccessToken || this.value.youtube.oauthRefreshToken)
      },
      overlay: {
        eventAnimation: { ...this.value.overlay.eventAnimation },
        eventAnimationRevision: this.value.overlay.eventAnimationRevision
      }
    };
  }

  updatePublic(input: any): void {
    if (input?.twitch) {
      if (typeof input.twitch.enabled === "boolean") this.value.twitch.enabled = input.twitch.enabled;
      if (typeof input.twitch.clientId === "string") this.value.twitch.clientId = input.twitch.clientId.trim();
      if (typeof input.twitch.clientSecret === "string" && input.twitch.clientSecret.trim()) {
        this.value.twitch.clientSecret = input.twitch.clientSecret.trim();
      }
      if (input.twitch.clearClientSecret === true) this.value.twitch.clientSecret = "";
      if (typeof input.twitch.channelLogin === "string") {
        this.value.twitch.channelLogin = input.twitch.channelLogin.trim().replace(/^@/, "").toLowerCase();
      }
    }

    if (input?.youtube) {
      if (typeof input.youtube.enabled === "boolean") this.value.youtube.enabled = input.youtube.enabled;
      if (typeof input.youtube.apiKey === "string" && input.youtube.apiKey.trim()) {
        this.value.youtube.apiKey = input.youtube.apiKey.trim();
      }
      if (input.youtube.clearApiKey === true) this.value.youtube.apiKey = "";
      if (typeof input.youtube.videoId === "string") this.value.youtube.videoId = normalizeYouTubeVideoId(input.youtube.videoId);
      if (typeof input.youtube.oauthClientId === "string") this.value.youtube.oauthClientId = input.youtube.oauthClientId.trim();
      if (typeof input.youtube.oauthClientSecret === "string" && input.youtube.oauthClientSecret.trim()) {
        this.value.youtube.oauthClientSecret = input.youtube.oauthClientSecret.trim();
      }
      if (input.youtube.clearOauthClientSecret === true) this.value.youtube.oauthClientSecret = "";
    }

    if (input?.overlay?.eventAnimation) {
      const incoming = input.overlay.eventAnimation;
      const current = this.value.overlay.eventAnimation;
      current.fps = clampNumber(incoming.fps, 12, 120, current.fps, true);
      current.trailLength = clampNumber(incoming.trailLength, 80, 700, current.trailLength, true);
      current.orbitDuration = clampNumber(incoming.orbitDuration, 1500, 12000, current.orbitDuration, true);
      current.orbSize = clampNumber(incoming.orbSize, 2, 16, current.orbSize, false);
      current.glowIntensity = clampNumber(incoming.glowIntensity, 0.35, 2.5, current.glowIntensity, false);
      current.eventDuration = clampNumber(incoming.eventDuration, 3000, 180000, current.eventDuration, true);
      this.value.overlay.eventAnimationRevision = EVENT_ANIMATION_REVISION;
    }

    if (input?.overlay?.resetEventAnimation === true) {
      this.value.overlay.eventAnimation = { ...DEFAULT_EVENT_ANIMATION };
      this.value.overlay.eventAnimationRevision = EVENT_ANIMATION_REVISION;
    }
    this.save();
  }

  setTwitchTokens(accessToken: string, refreshToken: string): void {
    this.value.twitch.accessToken = accessToken;
    this.value.twitch.refreshToken = refreshToken;
    this.save();
  }

  clearTwitchTokens(): void {
    this.value.twitch.accessToken = "";
    this.value.twitch.refreshToken = "";
    this.save();
  }

  setYouTubeOAuthTokens(accessToken: string, refreshToken: string, expiresInSeconds = 3600): void {
    this.value.youtube.oauthAccessToken = accessToken;
    if (refreshToken) this.value.youtube.oauthRefreshToken = refreshToken;
    this.value.youtube.oauthExpiresAt = Date.now() + Math.max(60, Number(expiresInSeconds || 3600)) * 1000;
    this.save();
  }

  clearYouTubeOAuthTokens(): void {
    this.value.youtube.oauthAccessToken = "";
    this.value.youtube.oauthRefreshToken = "";
    this.value.youtube.oauthExpiresAt = 0;
    this.save();
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }
}

function isKnownBrokenLegacyAnimation(animation: EventAnimationConfig): boolean {
  return animation.orbSize <= 2.01 && animation.glowIntensity <= 0.351;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number, integer: boolean): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

export function normalizeYouTubeVideoId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (url.hostname.endsWith("youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v") ?? "";
      const parts = url.pathname.split("/").filter(Boolean);
      if (["live", "shorts", "embed"].includes(parts[0])) return parts[1] ?? "";
    }
  } catch {
    // A plain video ID is valid input.
  }
  return trimmed;
}
