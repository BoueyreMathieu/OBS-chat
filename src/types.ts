export type ChatPlatform = "twitch" | "youtube";

export type EventCategory =
  | "chat"
  | "sub"
  | "resub"
  | "gift"
  | "reward"
  | "bits"
  | "raid"
  | "membership"
  | "superchat"
  | "supersticker"
  | "other";

export interface ChatBadge {
  id: string;
  label: string;
  imageUrl?: string;
  title?: string;
}

export type ChatFragment =
  | { type: "text"; text: string }
  | { type: "emote"; text: string; imageUrl?: string };

export interface ChatMessage {
  id: string;
  platform: ChatPlatform;
  kind?: "chat" | "event";
  eventType?: string;
  eventCategory?: EventCategory;
  eventStyle?: string;
  author: {
    id: string;
    name: string;
    color?: string;
    avatarUrl?: string;
    badges: ChatBadge[];
    roles: {
      broadcaster?: boolean;
      moderator?: boolean;
      subscriber?: boolean;
      verified?: boolean;
    };
  };
  content: {
    text: string;
    fragments: ChatFragment[];
  };
  flags?: {
    firstMessageThisStream?: boolean;
    firstMessageEver?: boolean;
  };
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export type ConnectionState = "disabled" | "needs-config" | "needs-auth" | "connecting" | "connected" | "error";

export interface PlatformStatus {
  platform: ChatPlatform;
  state: ConnectionState;
  detail: string;
  channel?: string;
  updatedAt: number;
}

export type ClientEvent =
  | { type: "chat-message"; payload: ChatMessage }
  | { type: "platform-status"; payload: PlatformStatus }
  | {
      type: "overlay-settings";
      payload: {
        fps: number;
        trailLength: number;
        orbitDuration: number;
        orbSize: number;
        glowIntensity: number;
        eventDuration: number;
      };
    };
