import { WebSocket } from "ws";
import type { AppConfig, ConfigStore } from "../config.js";
import type { ChatBadge, ChatFragment, ChatMessage, PlatformStatus } from "../types.js";

type EmitMessage = (message: ChatMessage) => void;
type EmitStatus = (status: PlatformStatus) => void;

type BadgeVersion = {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
};

type TwitchBadgeSet = { set_id: string; versions: BadgeVersion[] };

const SUPPORTED_NOTICE_TYPES = new Set([
  "sub",
  "resub",
  "sub_gift",
  "community_sub_gift",
  "gift_paid_upgrade",
  "prime_paid_upgrade",
  "pay_it_forward",
  "raid",
  "bits_badge_tier"
]);

export class TwitchIntegration {
  private socket: WebSocket | null = null;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private badgeMap = new Map<string, BadgeVersion>();
  private broadcasterUserId = "";
  private broadcasterLogin = "";
  private chatUserId = "";
  private tokenScopes = new Set<string>();
  private rewardsSubscribed = false;
  private trackedBroadcasterId = "";
  private currentStreamId = "";
  private seenChattersThisStream = new Set<string>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly emitMessage: EmitMessage,
    private readonly emitStatus: EmitStatus
  ) {}

  async start(): Promise<void> {
    this.stop();
    this.stopped = false;
    const cfg = this.configStore.get().twitch;

    if (!cfg.enabled) return this.status("disabled", "Intégration désactivée");
    if (!cfg.clientId || !cfg.clientSecret) return this.status("needs-config", "Client ID / secret Twitch manquants");
    if (!cfg.accessToken) return this.status("needs-auth", "Clique sur « Connecter Twitch »");

    this.status("connecting", "Validation du compte Twitch…");
    try {
      const identity = await this.validateOrRefresh(cfg);
      this.tokenScopes = new Set(Array.isArray(identity.scopes) ? identity.scopes : []);
      this.chatUserId = identity.user_id;
      const broadcaster = await this.resolveBroadcaster(this.configStore.get().twitch, identity);
      this.broadcasterUserId = broadcaster.id;
      this.broadcasterLogin = broadcaster.login;
      if (this.trackedBroadcasterId !== broadcaster.id) {
        this.trackedBroadcasterId = broadcaster.id;
        this.currentStreamId = "";
        this.seenChattersThisStream.clear();
      }
      await this.initializeStreamTracking();
      await this.loadBadges();
      await this.connectEventSub();
      this.scheduleRefresh(identity.expires_in);
    } catch (error) {
      this.status("error", formatError(error));
      this.scheduleReconnect(5000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.keepaliveTimer = null;
    this.tokenScopes.clear();
    this.rewardsSubscribed = false;
  }

  canSend(): boolean {
    return this.tokenScopes.has("user:write:chat");
  }

  canReceiveRewards(): boolean {
    return this.rewardsSubscribed;
  }

  async sendMessage(message: string): Promise<{ messageId?: string }> {
    const text = message.trim();
    if (!text) throw new Error("Le message Twitch est vide.");
    if (text.length > 500) throw new Error("Twitch limite les messages envoyés via l’API à 500 caractères.");

    let cfg = this.configStore.get().twitch;
    if (!cfg.enabled) throw new Error("Twitch est désactivé.");
    if (!cfg.clientId || !cfg.clientSecret || !cfg.accessToken) throw new Error("Twitch n’est pas authentifié.");

    const identity = await this.validateOrRefresh(cfg);
    this.tokenScopes = new Set(Array.isArray(identity.scopes) ? identity.scopes : []);
    if (!this.tokenScopes.has("user:write:chat")) {
      throw new Error("Permission Twitch user:write:chat manquante. Clique sur « Connecter Twitch » une fois pour mettre à jour l’autorisation.");
    }

    this.chatUserId = identity.user_id;
    if (!this.broadcasterUserId) {
      const broadcaster = await this.resolveBroadcaster(this.configStore.get().twitch, identity);
      this.broadcasterUserId = broadcaster.id;
      this.broadcasterLogin = broadcaster.login;
    }

    cfg = this.configStore.get().twitch;
    const response = await fetch("https://api.twitch.tv/helix/chat/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Client-Id": cfg.clientId,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        broadcaster_id: this.broadcasterUserId,
        sender_id: identity.user_id,
        message: text
      })
    });

    if (!response.ok) throw new Error(`Envoi Twitch impossible (${response.status}) : ${await compactApiError(response)}`);
    const data = await response.json();
    const result = data?.data?.[0];
    if (result && result.is_sent === false) {
      throw new Error(result.drop_reason?.message || result.drop_reason?.code || "Twitch a refusé le message.");
    }
    return { messageId: result?.message_id };
  }

  private async validateOrRefresh(cfg: AppConfig["twitch"]): Promise<any> {
    try {
      return await validateToken(cfg.accessToken);
    } catch (error) {
      if (!cfg.refreshToken) {
        this.configStore.clearTwitchTokens();
        throw new Error("Token Twitch expiré. Reconnecte Twitch depuis le dashboard.");
      }
      const tokens = await refreshAccessToken(cfg.clientId, cfg.clientSecret, cfg.refreshToken);
      this.configStore.setTwitchTokens(tokens.access_token, tokens.refresh_token || cfg.refreshToken);
      return await validateToken(tokens.access_token);
    }
  }

  private async resolveBroadcaster(cfg: AppConfig["twitch"], identity: any): Promise<{ id: string; login: string }> {
    if (!cfg.channelLogin || cfg.channelLogin.toLowerCase() === String(identity.login).toLowerCase()) {
      return { id: identity.user_id, login: identity.login };
    }
    const data = await this.helix(`/users?login=${encodeURIComponent(cfg.channelLogin)}`);
    const user = data.data?.[0];
    if (!user) throw new Error(`Chaîne Twitch introuvable : ${cfg.channelLogin}`);
    return { id: user.id, login: user.login };
  }

  private async loadBadges(): Promise<void> {
    const [globalData, channelData] = await Promise.all([
      this.helix("/chat/badges/global"),
      this.helix(`/chat/badges?broadcaster_id=${encodeURIComponent(this.broadcasterUserId)}`)
    ]);
    this.badgeMap.clear();
    this.indexBadges(globalData.data ?? []);
    // Les badges de chaîne ont priorité sur les badges globaux du même set/version.
    this.indexBadges(channelData.data ?? []);
  }

  private indexBadges(sets: TwitchBadgeSet[]): void {
    for (const set of sets) {
      for (const version of set.versions ?? []) {
        this.badgeMap.set(`${set.set_id}:${version.id}`, version);
      }
    }
  }

  private async connectEventSub(url = "wss://eventsub.wss.twitch.tv/ws", createSubscriptions = true): Promise<void> {
    if (this.stopped) return;
    this.status("connecting", "Connexion à Twitch EventSub…");
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("message", async (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        const type = envelope?.metadata?.message_type;
        const keepaliveSeconds = envelope?.payload?.session?.keepalive_timeout_seconds;
        this.armKeepalive(socket, keepaliveSeconds);

        if (type === "session_welcome") {
          const sessionId = envelope.payload?.session?.id;
          if (!sessionId) throw new Error("EventSub : session_id absent");
          if (createSubscriptions) await this.createSubscriptions(sessionId);
          this.status("connected", "Chat + événements Twitch connectés", this.broadcasterLogin);
          return;
        }

        if (type === "notification") {
          const subscriptionType = envelope.payload?.subscription?.type;
          if (subscriptionType === "channel.chat.message") {
            const mapped = this.toChatMessage(envelope.payload.event);
            if (mapped) this.emitMessage(mapped);
            return;
          }
          if (subscriptionType === "channel.chat.notification") {
            const mapped = this.toChatNotification(envelope.payload.event);
            if (mapped) this.emitMessage(mapped);
            return;
          }
          if (subscriptionType === "channel.channel_points_custom_reward_redemption.add") {
            const mapped = this.toRewardRedemption(envelope.payload.event);
            if (mapped) this.emitMessage(mapped);
            return;
          }
          if (subscriptionType === "stream.online") {
            const streamId = String(envelope.payload?.event?.id ?? "");
            if (streamId && streamId !== this.currentStreamId) {
              this.currentStreamId = streamId;
              this.seenChattersThisStream.clear();
            }
            return;
          }
          if (subscriptionType === "stream.offline") {
            this.currentStreamId = "";
            this.seenChattersThisStream.clear();
            return;
          }
        }

        if (type === "session_reconnect") {
          const reconnectUrl = envelope.payload?.session?.reconnect_url;
          if (reconnectUrl) await this.handoffReconnect(reconnectUrl, socket);
          return;
        }

        if (type === "revocation") {
          const reason = envelope.payload?.subscription?.status ?? "revoked";
          this.status("error", `Abonnement Twitch révoqué : ${reason}`);
        }
      } catch (error) {
        console.error("Twitch EventSub:", error);
      }
    });

    socket.on("error", (error) => console.error("Twitch WebSocket:", error));
    socket.on("close", () => {
      if (!this.stopped && this.socket === socket) {
        this.status("connecting", "Twitch déconnecté, reconnexion…", this.broadcasterLogin);
        this.scheduleReconnect(2500);
      }
    });
  }

  private async handoffReconnect(url: string, oldSocket: WebSocket): Promise<void> {
    // Twitch demande d'ouvrir l'URL de reconnexion fournie. Le nouveau socket remplace l'ancien
    // et conserve les abonnements EventSub existants, donc on ne les recrée pas lors du handoff.
    await this.connectEventSub(url, false);
    setTimeout(() => {
      try { oldSocket.close(); } catch { /* noop */ }
    }, 1000);
  }

  private armKeepalive(socket: WebSocket, seconds?: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    const timeoutMs = Math.max(15_000, Number(seconds || 10) * 1000 + 5_000);
    this.keepaliveTimer = setTimeout(() => {
      if (!this.stopped && this.socket === socket) {
        console.warn("Twitch EventSub: keepalive dépassé, reconnexion.");
        try { socket.terminate(); } catch { socket.close(); }
      }
    }, timeoutMs);
  }

  private async createSubscriptions(sessionId: string): Promise<void> {
    // Chat + notifications utilisent user:read:chat. Les redemptions custom demandent
    // channel:read:redemptions et doivent viser la chaîne du broadcaster authentifié.
    await Promise.all([
      this.createEventSubSubscription("channel.chat.message", sessionId, {
        broadcaster_user_id: this.broadcasterUserId,
        user_id: this.chatUserId
      }),
      this.createEventSubSubscription("channel.chat.notification", sessionId, {
        broadcaster_user_id: this.broadcasterUserId,
        user_id: this.chatUserId
      }),
      this.createEventSubSubscription("stream.online", sessionId, {
        broadcaster_user_id: this.broadcasterUserId
      }),
      this.createEventSubSubscription("stream.offline", sessionId, {
        broadcaster_user_id: this.broadcasterUserId
      })
    ]);

    if (this.tokenScopes.has("channel:read:redemptions") && this.broadcasterUserId === this.chatUserId) {
      try {
        await this.createEventSubSubscription("channel.channel_points_custom_reward_redemption.add", sessionId, {
          broadcaster_user_id: this.broadcasterUserId
        });
        this.rewardsSubscribed = true;
      } catch (error) {
        // Un compte sans Channel Points (non Affiliate/Partner) ne doit pas casser le chat.
        this.rewardsSubscribed = false;
        console.warn("Twitch rewards: abonnement EventSub indisponible:", formatError(error));
      }
    } else {
      this.rewardsSubscribed = false;
      console.warn("Twitch rewards: scope channel:read:redemptions absent ou chaîne différente du compte autorisé. Reconnecte Twitch pour activer les rewards.");
    }
  }

  private async createEventSubSubscription(type: string, sessionId: string, condition: Record<string, string>): Promise<void> {
    const cfg = this.configStore.get().twitch;
    const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Client-Id": cfg.clientId,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type,
        version: "1",
        condition,
        transport: {
          method: "websocket",
          session_id: sessionId
        }
      })
    });
    if (!response.ok) throw new Error(`Création EventSub ${type} impossible (${response.status}) : ${await response.text()}`);
  }

  private toChatMessage(event: any): ChatMessage | null {
    if (event?.channel_points_custom_reward_id && this.canReceiveRewards()) return null;
    const rawBadges = Array.isArray(event.badges) ? event.badges : [];
    const badges = this.resolveBadges(rawBadges);
    const fragments = this.mapFragments(event.message?.fragments ?? []);
    const badgeSets = new Set(rawBadges.map((badge: any) => badge.set_id));
    const bits = Number(event.cheer?.bits || 0);
    const isCheer = bits > 0;
    const cheerTier = isCheer ? resolveCheerTier(event.message?.fragments ?? [], bits) : 0;
    const originalText = String(event.message?.text ?? "");
    const chatterId = String(event.chatter_user_id ?? "");
    const firstMessageEver = String(event.message_type ?? "") === "user_intro";
    let firstMessageThisStream = false;
    if (this.currentStreamId && chatterId && chatterId !== this.broadcasterUserId) {
      firstMessageThisStream = !this.seenChattersThisStream.has(chatterId);
      this.seenChattersThisStream.add(chatterId);
    }
    const contentText = isCheer ? `a envoyé ${bits.toLocaleString("fr-FR")} Bits !${originalText ? ` — ${originalText}` : ""}` : originalText;
    const contentFragments: ChatFragment[] = isCheer
      ? [{ type: "text", text: `a envoyé ${bits.toLocaleString("fr-FR")} Bits !${originalText ? " — " : ""}` }, ...fragments]
      : (fragments.length ? fragments : [{ type: "text", text: originalText }]);

    return {
      id: event.message_id,
      platform: "twitch",
      kind: isCheer ? "event" : "chat",
      eventType: isCheer ? "cheer" : undefined,
      eventCategory: isCheer ? "bits" : "chat",
      eventStyle: isCheer ? `bits-tier${cheerTier}` : undefined,
      author: {
        id: event.chatter_user_id,
        name: event.chatter_user_name || event.chatter_user_login,
        color: event.color || undefined,
        badges,
        roles: {
          broadcaster: badgeSets.has("broadcaster"),
          moderator: badgeSets.has("moderator"),
          subscriber: badgeSets.has("subscriber") || badgeSets.has("founder")
        }
      },
      content: {
        text: contentText,
        fragments: contentFragments
      },
      flags: firstMessageEver || firstMessageThisStream ? {
        firstMessageThisStream,
        firstMessageEver
      } : undefined,
      metadata: isCheer ? { bits, cheermoteTier: cheerTier } : undefined,
      timestamp: Date.now()
    };
  }

  private toChatNotification(event: any): ChatMessage | null {
    const noticeType = String(event?.notice_type ?? "");
    if (!SUPPORTED_NOTICE_TYPES.has(noticeType)) return null;
    // Un community gift génère aussi des sub_gift individuels. L'agrégat suffit dans le feed ;
    // sinon un cadeau de 50 subs produirait 51 cartes à l'écran.
    if (noticeType === "sub_gift" && event.sub_gift?.community_gift_id) return null;

    const rawBadges = Array.isArray(event.badges) ? event.badges : [];
    const badges = this.resolveBadges(rawBadges);
    const badgeSets = new Set(rawBadges.map((badge: any) => badge.set_id));
    const eventText = formatNoticeText(event);
    const viewerText = String(event.message?.text ?? "").trim();
    const viewerFragments = this.mapFragments(event.message?.fragments ?? []);

    const fragments: ChatFragment[] = [{ type: "text", text: eventText }];
    if (viewerText) {
      fragments.push({ type: "text", text: " — " });
      if (viewerFragments.length) fragments.push(...viewerFragments);
      else fragments.push({ type: "text", text: viewerText });
    }

    const chatterName = event.chatter_is_anonymous
      ? "Anonyme"
      : (event.chatter_user_name || event.chatter_user_login || "Twitch");

    return {
      id: event.message_id || `twitch-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      platform: "twitch",
      kind: "event",
      eventType: noticeType,
      eventCategory: noticeCategory(noticeType),
      eventStyle: noticeStyle(event),
      author: {
        id: event.chatter_user_id || `anonymous-${noticeType}`,
        name: chatterName,
        color: event.color || undefined,
        badges,
        roles: {
          broadcaster: badgeSets.has("broadcaster"),
          moderator: badgeSets.has("moderator"),
          subscriber: badgeSets.has("subscriber") || badgeSets.has("founder") || noticeType === "sub" || noticeType === "resub"
        }
      },
      content: {
        text: viewerText ? `${eventText} — ${viewerText}` : eventText,
        fragments
      },
      timestamp: Date.now()
    };
  }

  private toRewardRedemption(event: any): ChatMessage | null {
    const reward = event?.reward ?? {};
    const title = String(reward.title ?? "Récompense").trim() || "Récompense";
    const cost = Number(reward.cost || 0);
    const userInput = String(event?.user_input ?? "").trim();
    const costText = cost > 0 ? ` (${cost.toLocaleString("fr-FR")} pts)` : "";
    const actionText = `a utilisé « ${title} »${costText}${userInput ? ` : ${userInput}` : ""}`;

    return {
      id: event?.id || `twitch-reward-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      platform: "twitch",
      kind: "event",
      eventType: "reward",
      eventCategory: "reward",
      eventStyle: "reward",
      author: {
        id: event?.user_id || "unknown-reward-user",
        name: event?.user_name || event?.user_login || "Viewer Twitch",
        badges: [],
        roles: {}
      },
      content: {
        text: actionText,
        fragments: [{ type: "text", text: actionText }]
      },
      metadata: {
        redemptionId: event?.id,
        rewardId: reward.id,
        rewardTitle: title,
        rewardCost: cost,
        userInput,
        status: event?.status
      },
      timestamp: event?.redeemed_at ? Date.parse(event.redeemed_at) : Date.now()
    };
  }

  private async initializeStreamTracking(): Promise<void> {
    try {
      const data = await this.helix(`/streams?user_id=${encodeURIComponent(this.broadcasterUserId)}`);
      const streamId = String(data?.data?.[0]?.id ?? "");
      if (streamId !== this.currentStreamId) {
        this.currentStreamId = streamId;
        this.seenChattersThisStream.clear();
      }
    } catch (error) {
      // Le chat reste fonctionnel même si l'état live ne peut pas être résolu.
      console.warn("Twitch stream tracking:", formatError(error));
    }
  }

  private resolveBadges(rawBadges: any[]): ChatBadge[] {
    return rawBadges.map((badge: any) => {
      const asset = this.badgeMap.get(`${badge.set_id}:${badge.id}`);
      return {
        id: `${badge.set_id}:${badge.id}`,
        label: asset?.title || badge.set_id,
        imageUrl: asset?.image_url_2x || asset?.image_url_1x || "/assets/badges/generic.svg",
        title: asset?.description || asset?.title || `${badge.set_id} (asset Twitch non résolu)`
      };
    });
  }

  private mapFragments(rawFragments: any[]): ChatFragment[] {
    return rawFragments.map((fragment: any) => {
      if (fragment.type === "emote" && fragment.emote?.id) {
        return {
          type: "emote" as const,
          text: fragment.text ?? "",
          imageUrl: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(fragment.emote.id)}/static/dark/2.0`
        };
      }
      return { type: "text" as const, text: fragment.text ?? "" };
    });
  }

  private async helix(path: string): Promise<any> {
    let cfg = this.configStore.get().twitch;
    let response = await fetch(`https://api.twitch.tv/helix${path}`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}`, "Client-Id": cfg.clientId }
    });

    if (response.status === 401 && cfg.refreshToken) {
      const tokens = await refreshAccessToken(cfg.clientId, cfg.clientSecret, cfg.refreshToken);
      this.configStore.setTwitchTokens(tokens.access_token, tokens.refresh_token || cfg.refreshToken);
      cfg = this.configStore.get().twitch;
      response = await fetch(`https://api.twitch.tv/helix${path}`, {
        headers: { Authorization: `Bearer ${cfg.accessToken}`, "Client-Id": cfg.clientId }
      });
    }

    if (!response.ok) throw new Error(`Twitch Helix ${response.status}: ${await response.text()}`);
    return response.json();
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(60_000, (Number(expiresInSeconds || 3600) - 300) * 1000);
    this.refreshTimer = setTimeout(async () => {
      try {
        const cfg = this.configStore.get().twitch;
        if (!cfg.refreshToken) return;
        const tokens = await refreshAccessToken(cfg.clientId, cfg.clientSecret, cfg.refreshToken);
        this.configStore.setTwitchTokens(tokens.access_token, tokens.refresh_token || cfg.refreshToken);
        const identity = await validateToken(tokens.access_token);
        this.scheduleRefresh(identity.expires_in);
      } catch (error) {
        console.error("Refresh Twitch:", error);
      }
    }, delay);
  }

  private status(state: PlatformStatus["state"], detail: string, channel?: string): void {
    this.emitStatus({ platform: "twitch", state, detail, channel, updatedAt: Date.now() });
  }
}

export function buildTwitchAuthorizeUrl(config: AppConfig["twitch"], redirectUri: string, state: string): string {
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "user:read:chat user:write:chat channel:read:redemptions");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeTwitchCode(config: AppConfig["twitch"], code: string, redirectUri: string): Promise<any> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!response.ok) throw new Error(`OAuth Twitch ${response.status}: ${await response.text()}`);
  return response.json();
}

async function validateToken(accessToken: string): Promise<any> {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Token Twitch invalide (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data.scopes) || !data.scopes.includes("user:read:chat")) {
    throw new Error("Le token Twitch n'a pas le scope user:read:chat. Reconnecte Twitch.");
  }
  return data;
}

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<any> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!response.ok) throw new Error(`Refresh Twitch ${response.status}: ${await response.text()}`);
  return response.json();
}

function formatNoticeText(event: any): string {
  const type = String(event?.notice_type ?? "unknown");
  switch (type) {
    case "sub": {
      const info = event.sub ?? {};
      const tier = tierLabel(info.sub_tier);
      const method = info.is_prime ? " avec Prime" : tier ? ` (${tier})` : "";
      return `s'est abonné${method} !`;
    }
    case "resub": {
      const info = event.resub ?? {};
      const months = Number(info.cumulative_months || 0);
      const tier = tierLabel(info.sub_tier);
      const monthText = months > 0 ? ` pour son ${months}e mois` : "";
      const tierText = tier ? ` (${tier})` : "";
      return `s'est réabonné${monthText}${tierText} !`;
    }
    case "sub_gift": {
      const info = event.sub_gift ?? {};
      const recipient = info.recipient_user_name || info.recipient_user_login || "un viewer";
      const tier = tierLabel(info.sub_tier);
      return `a offert un abonnement${tier ? ` ${tier}` : ""} à ${recipient} !`;
    }
    case "community_sub_gift": {
      const info = event.community_sub_gift ?? {};
      const total = Number(info.total || 0);
      const tier = tierLabel(info.sub_tier);
      return `a offert ${total || "plusieurs"} abonnement${total === 1 ? "" : "s"}${tier ? ` ${tier}` : ""} à la communauté !`;
    }
    case "gift_paid_upgrade":
      return "a continué un abonnement qui lui avait été offert !";
    case "prime_paid_upgrade":
      return "a transformé son abonnement Prime en abonnement payant !";
    case "pay_it_forward":
      return "a payé un abonnement offert au suivant !";
    case "raid": {
      const viewers = Number(event.raid?.viewer_count || 0);
      return `arrive en raid${viewers ? ` avec ${viewers.toLocaleString("fr-FR")} viewer${viewers === 1 ? "" : "s"}` : ""} !`;
    }
    case "bits_badge_tier": {
      const tier = Number(event.bits_badge_tier?.tier || 0);
      return `a débloqué le badge Bits${tier ? ` ${tier.toLocaleString("fr-FR")}` : ""} !`;
    }
    default:
      return String(event.system_message || "Événement Twitch");
  }
}

function noticeStyle(event: any): string {
  const type = String(event?.notice_type ?? "");
  const tierFor = (info: any, allowPrime = false) => {
    if (allowPrime && info?.is_prime) return "prime";
    switch (String(info?.sub_tier ?? "")) {
      case "1000": return "tier1";
      case "2000": return "tier2";
      case "3000": return "tier3";
      default: return "generic";
    }
  };

  switch (type) {
    case "sub": return `sub-${tierFor(event.sub, true)}`;
    case "resub": return `resub-${tierFor(event.resub, true)}`;
    case "sub_gift": return `gift-${tierFor(event.sub_gift)}`;
    case "community_sub_gift": return `community-gift-${tierFor(event.community_sub_gift)}`;
    case "prime_paid_upgrade": return `upgrade-${tierFor(event.prime_paid_upgrade)}`;
    case "gift_paid_upgrade": return "upgrade-gift";
    case "pay_it_forward": return "pay-it-forward";
    case "raid": return "raid";
    case "bits_badge_tier": return "bits";
    default: return "event-generic";
  }
}


function resolveCheerTier(rawFragments: any[], bits: number): number {
  for (const fragment of rawFragments ?? []) {
    const tier = Number(fragment?.cheermote?.tier || 0);
    if (Number.isFinite(tier) && tier > 0) return bitsTierBucket(tier);
  }
  return bitsTierBucket(bits);
}

function bitsTierBucket(value: number): number {
  if (value >= 100000) return 100000;
  if (value >= 10000) return 10000;
  if (value >= 5000) return 5000;
  if (value >= 1000) return 1000;
  if (value >= 100) return 100;
  return 1;
}

function noticeCategory(type: string): "sub" | "resub" | "gift" | "raid" | "bits" | "other" {
  switch (type) {
    case "sub": return "sub";
    case "resub": return "resub";
    case "sub_gift":
    case "community_sub_gift":
    case "gift_paid_upgrade":
    case "prime_paid_upgrade":
    case "pay_it_forward": return "gift";
    case "raid": return "raid";
    case "bits_badge_tier": return "bits";
    default: return "other";
  }
}

function tierLabel(raw: unknown): string {
  switch (String(raw ?? "")) {
    case "1000": return "Tier 1";
    case "2000": return "Tier 2";
    case "3000": return "Tier 3";
    default: return "";
  }
}

async function compactApiError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.message || parsed?.error?.message || text || response.statusText;
  } catch {
    return text || response.statusText;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
