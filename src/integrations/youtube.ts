import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigStore } from "../config.js";
import type { ChatBadge, ChatMessage, PlatformStatus } from "../types.js";

type EmitMessage = (message: ChatMessage) => void;
type EmitStatus = (status: PlatformStatus) => void;

const ICONS = {
  owner: "/assets/badges/youtube-owner.svg",
  moderator: "/assets/badges/youtube-moderator.svg",
  member: "/assets/badges/youtube-member.svg",
  verified: "/assets/badges/youtube-verified.svg"
};

class YouTubeQuotaError extends Error {}

export class YouTubeIntegration {
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stream: grpc.ClientReadableStream<any> | null = null;
  private client: any = null;
  private liveChatId = "";
  private nextPageToken = "";
  private seen = new Set<string>();
  private videoId = "";
  private sessionStartedAt = 0;
  private quotaPaused = false;
  private channelNameCache = new Map<string, string>();
  private processingChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly emitMessage: EmitMessage,
    private readonly emitStatus: EmitStatus
  ) {}

  async start(): Promise<void> {
    this.stop();
    this.stopped = false;
    this.quotaPaused = false;
    this.sessionStartedAt = Date.now();

    const cfg = this.configStore.get().youtube;
    if (!cfg.enabled) return this.status("disabled", "Intégration désactivée");
    if (!cfg.apiKey || !cfg.videoId) return this.status("needs-config", "Clé API YouTube et URL/ID du live requis");

    this.videoId = cfg.videoId;
    this.status("connecting", "Recherche du chat YouTube…");

    try {
      this.liveChatId = await this.resolveLiveChatId(cfg.apiKey, cfg.videoId);
      this.status("connecting", "Ouverture du flux YouTube streamList…", cfg.videoId);
      this.openStream();
    } catch (error) {
      if (error instanceof YouTubeQuotaError) return this.pauseForQuota();
      this.status("error", friendlyError(error), cfg.videoId);
      this.scheduleRestart(10_000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.stream) {
      this.stream.removeAllListeners();
      try { this.stream.cancel(); } catch { /* noop */ }
      this.stream = null;
    }
    if (this.client) {
      try { this.client.close(); } catch { /* noop */ }
      this.client = null;
    }

    this.liveChatId = "";
    this.nextPageToken = "";
    this.seen.clear();
    this.processingChain = Promise.resolve();
  }

  canSend(): boolean {
    const cfg = this.configStore.get().youtube;
    return Boolean(cfg.oauthClientId && cfg.oauthClientSecret && (cfg.oauthAccessToken || cfg.oauthRefreshToken));
  }

  async sendMessage(message: string): Promise<{ messageId?: string }> {
    const text = message.trim();
    if (!text) throw new Error("Le message YouTube est vide.");

    const cfg = this.configStore.get().youtube;
    if (!cfg.enabled) throw new Error("YouTube est désactivé.");
    if (!cfg.videoId || !cfg.apiKey) throw new Error("Configure d’abord le live YouTube et la clé API.");
    if (!cfg.oauthClientId || !cfg.oauthClientSecret) throw new Error("Client OAuth YouTube manquant pour l’envoi.");
    if (!cfg.oauthAccessToken && !cfg.oauthRefreshToken) throw new Error("YouTube n’est pas autorisé pour l’envoi. Clique sur « Connecter YouTube pour l’envoi ».");

    if (!this.liveChatId) this.liveChatId = await this.resolveLiveChatId(cfg.apiKey, cfg.videoId);
    const accessToken = await this.getValidSendAccessToken();
    let response = await this.insertChatMessage(accessToken, text);

    if (response.status === 401 && this.configStore.get().youtube.oauthRefreshToken) {
      const refreshed = await this.refreshSendAccessToken();
      response = await this.insertChatMessage(refreshed, text);
    }

    if (!response.ok) throw await youtubeRestError("Envoi YouTube", response);
    const data = await response.json();
    return { messageId: data?.id };
  }

  private async insertChatMessage(accessToken: string, text: string): Promise<Response> {
    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.searchParams.set("part", "snippet");
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        snippet: {
          liveChatId: this.liveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: text }
        }
      })
    });
  }

  private async getValidSendAccessToken(): Promise<string> {
    const cfg = this.configStore.get().youtube;
    if (cfg.oauthAccessToken && cfg.oauthExpiresAt > Date.now() + 60_000) return cfg.oauthAccessToken;
    if (cfg.oauthRefreshToken) return this.refreshSendAccessToken();
    if (cfg.oauthAccessToken) return cfg.oauthAccessToken;
    throw new Error("Autorisation YouTube d’envoi absente.");
  }

  private async refreshSendAccessToken(): Promise<string> {
    const cfg = this.configStore.get().youtube;
    if (!cfg.oauthClientId || !cfg.oauthClientSecret || !cfg.oauthRefreshToken) {
      throw new Error("Impossible de renouveler l’autorisation YouTube. Reconnecte YouTube pour l’envoi.");
    }
    const body = new URLSearchParams({
      client_id: cfg.oauthClientId,
      client_secret: cfg.oauthClientSecret,
      refresh_token: cfg.oauthRefreshToken,
      grant_type: "refresh_token"
    });
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
    if (!response.ok) throw new Error(`Refresh OAuth YouTube ${response.status}: ${await response.text()}`);
    const tokens = await response.json();
    this.configStore.setYouTubeOAuthTokens(tokens.access_token, tokens.refresh_token || cfg.oauthRefreshToken, tokens.expires_in);
    return tokens.access_token;
  }

  private async resolveLiveChatId(apiKey: string, videoId: string): Promise<string> {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,liveStreamingDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", apiKey);

    const response = await fetch(url);
    if (!response.ok) throw await youtubeRestError("YouTube videos.list", response);

    const data = await response.json();
    const video = data.items?.[0];
    if (!video) throw new Error("Vidéo YouTube introuvable");
    const chatId = video.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) throw new Error("Ce live n'a pas de chat actif (pas encore en direct, terminé ou chat désactivé)");
    this.videoId = videoId;
    return chatId;
  }

  private openStream(): void {
    if (this.stopped || this.quotaPaused || !this.liveChatId) return;

    try {
      this.ensureGrpcClient();
      const cfg = this.configStore.get().youtube;
      const metadata = new grpc.Metadata();
      metadata.set("x-goog-api-key", cfg.apiKey);

      const request: Record<string, unknown> = {
        liveChatId: this.liveChatId,
        part: ["id", "snippet", "authorDetails"],
        hl: "fr",
        profileImageSize: 64
      };
      if (this.nextPageToken) request.pageToken = this.nextPageToken;

      const streamMethod = this.client?.streamList ?? this.client?.StreamList;
      if (typeof streamMethod !== "function") throw new Error("Client gRPC YouTube invalide : méthode streamList introuvable");

      const call: grpc.ClientReadableStream<any> = streamMethod.call(this.client, request, metadata);
      this.stream = call;
      this.status("connected", "Chat YouTube connecté — streamList", this.videoId);

      call.on("data", (response: any) => {
        this.processingChain = this.processingChain
          .then(() => this.handleStreamResponse(response))
          .catch((error) => this.handleProcessingError(error));
      });

      call.on("error", (error: grpc.ServiceError) => {
        if (this.stopped || (error.code === grpc.status.CANCELLED && this.stream !== call)) return;
        this.handleGrpcError(error);
      });

      call.on("end", () => {
        if (this.stream === call) this.stream = null;
        if (!this.stopped && !this.quotaPaused) {
          this.status("connecting", "Flux YouTube interrompu, reconnexion…", this.videoId);
          this.scheduleStreamReconnect(1500);
        }
      });
    } catch (error) {
      this.status("error", friendlyError(error), this.videoId);
      this.scheduleStreamReconnect(5000);
    }
  }

  private ensureGrpcClient(): void {
    if (this.client) return;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const protoPath = path.resolve(__dirname, "../../proto/stream_list.proto");

    const definition = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true
    });
    const loaded = grpc.loadPackageDefinition(definition) as any;
    const Service = loaded?.youtube?.api?.v3?.V3DataLiveChatMessageService;
    if (!Service) throw new Error("Impossible de charger le service gRPC YouTube streamList");
    this.client = new Service("dns:///youtube.googleapis.com:443", grpc.credentials.createSsl());
  }

  private async handleStreamResponse(response: any): Promise<void> {
    if (this.stopped || this.quotaPaused) return;
    if (response?.nextPageToken) this.nextPageToken = response.nextPageToken;

    const items: any[] = Array.isArray(response?.items) ? response.items : [];
    const freshItems: any[] = [];

    for (const item of items) {
      if (!item?.id || this.seen.has(item.id)) continue;
      this.seen.add(item.id);

      const publishedAt = Date.parse(item.snippet?.publishedAt ?? "");
      // streamList envoie de l'historique à la première connexion. On le marque comme vu
      // mais on n'injecte dans OBS que les événements publiés après le démarrage de cette session.
      if (Number.isFinite(publishedAt) && publishedAt < this.sessionStartedAt) continue;
      freshItems.push(item);
    }

    this.trimSeen();
    if (!freshItems.length) return;

    await this.resolveChannelNamesForItems(freshItems);
    for (const item of freshItems) {
      const mapped = this.toChatMessage(item);
      if (mapped) this.emitMessage(mapped);
    }
  }

  private async resolveChannelNamesForItems(items: any[]): Promise<void> {
    const cfg = this.configStore.get().youtube;
    const fallbackNames = new Map<string, string>();

    for (const item of items) {
      const author = item.authorDetails ?? {};
      if (!author.channelId) continue;
      fallbackNames.set(author.channelId, author.displayName || "YouTube");
    }

    const unknownIds = [...fallbackNames.keys()].filter((id) => !this.channelNameCache.has(id));
    if (!unknownIds.length) return;

    for (let index = 0; index < unknownIds.length; index += 50) {
      const ids = unknownIds.slice(index, index + 50);
      try {
        const url = new URL("https://www.googleapis.com/youtube/v3/channels");
        url.searchParams.set("part", "snippet");
        url.searchParams.set("id", ids.join(","));
        url.searchParams.set("maxResults", "50");
        url.searchParams.set("key", cfg.apiKey);

        const response = await fetch(url);
        if (!response.ok) throw await youtubeRestError("YouTube channels.list", response);
        const data = await response.json();
        const resolved = new Set<string>();

        for (const channel of data.items ?? []) {
          if (!channel?.id) continue;
          const title = String(channel.snippet?.title ?? "").trim();
          if (title) {
            this.channelNameCache.set(channel.id, title);
            resolved.add(channel.id);
          }
        }

        for (const id of ids) {
          if (!resolved.has(id)) this.channelNameCache.set(id, fallbackNames.get(id) || "YouTube");
        }
      } catch (error) {
        if (error instanceof YouTubeQuotaError) throw error;
        console.warn("Résolution nom de chaîne YouTube:", friendlyError(error));
        // En cas d'erreur ponctuelle, on garde le displayName/handle fourni par le live chat
        // et on le met en cache pour ne pas refaire un appel à chaque message.
        for (const id of ids) this.channelNameCache.set(id, fallbackNames.get(id) || "YouTube");
      }
    }
  }

  private toChatMessage(item: any): ChatMessage | null {
    const snippet = item.snippet ?? {};
    const author = item.authorDetails ?? {};
    const type = String(snippet.type || "TEXT_MESSAGE_EVENT").toUpperCase();
    const isText = type === "TEXT_MESSAGE_EVENT";
    const isSupportedEvent = new Set([
      "NEW_SPONSOR_EVENT",
      "MEMBER_MILESTONE_CHAT_EVENT",
      "MEMBERSHIP_GIFTING_EVENT",
      "GIFT_MEMBERSHIP_RECEIVED_EVENT",
      "SUPER_CHAT_EVENT",
      "SUPER_STICKER_EVENT"
    ]).has(type);

    if (!author.channelId) return null;
    if (isText && (!snippet.hasDisplayContent || !snippet.displayMessage)) return null;
    if (!isText && !isSupportedEvent) return null;

    const badges: ChatBadge[] = [];
    if (author.isChatOwner) badges.push({ id: "youtube-owner", label: "Owner", imageUrl: ICONS.owner, title: "Propriétaire de la chaîne" });
    if (author.isChatModerator && !author.isChatOwner) badges.push({ id: "youtube-moderator", label: "Mod", imageUrl: ICONS.moderator, title: "Modérateur YouTube" });
    if (author.isChatSponsor) badges.push({
      id: "youtube-member",
      label: "Member",
      imageUrl: ICONS.member,
      title: "Membre YouTube — l'API officielle n'expose pas l'image du badge personnalisé de la chaîne"
    });
    if (author.isVerified) badges.push({ id: "youtube-verified", label: "Verified", imageUrl: ICONS.verified, title: "Compte vérifié" });

    const resolvedName = this.channelNameCache.get(author.channelId) || author.displayName || "YouTube";
    const eventInfo = youtubeEventInfo(type, snippet);
    const text = eventInfo?.text || String(snippet.displayMessage || "").trim();
    if (!text) return null;

    return {
      id: item.id,
      platform: "youtube",
      kind: isText ? "chat" : "event",
      eventType: isText ? undefined : type.toLowerCase(),
      eventCategory: isText ? "chat" : eventInfo?.category || "other",
      eventStyle: isText ? undefined : eventInfo?.style || "event-generic",
      author: {
        id: author.channelId,
        name: resolvedName,
        avatarUrl: author.profileImageUrl || undefined,
        badges,
        roles: {
          broadcaster: Boolean(author.isChatOwner),
          moderator: Boolean(author.isChatModerator),
          subscriber: Boolean(author.isChatSponsor),
          verified: Boolean(author.isVerified)
        }
      },
      content: {
        text,
        fragments: [{ type: "text", text }]
      },
      metadata: eventInfo?.metadata,
      timestamp: snippet.publishedAt ? Date.parse(snippet.publishedAt) : Date.now()
    };
  }

  private handleProcessingError(error: unknown): void {
    if (error instanceof YouTubeQuotaError) {
      this.pauseForQuota();
      return;
    }
    console.error("YouTube stream processing:", error);
  }

  private handleGrpcError(error: grpc.ServiceError): void {
    if (this.stopped) return;
    if (error.code === grpc.status.RESOURCE_EXHAUSTED) {
      this.pauseForQuota("Quota ou limite de débit YouTube atteinte — flux mis en pause. Réessaie après le reset du quota.");
      return;
    }

    const detail = cleanGrpcDetail(error.details || error.message);
    this.status("error", `YouTube streamList : ${detail}`, this.videoId);
    this.scheduleStreamReconnect(error.code === grpc.status.FAILED_PRECONDITION ? 15_000 : 4000);
  }

  private pauseForQuota(detail = "Quota YouTube épuisé — flux mis en pause. Après le reset quotidien, clique sur « Enregistrer / reconnecter ». "): void {
    this.quotaPaused = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      stream.removeAllListeners();
      try { stream.cancel(); } catch { /* noop */ }
    }
    this.status("error", detail.trim(), this.videoId);
  }

  private scheduleStreamReconnect(delay: number): void {
    if (this.stopped || this.quotaPaused || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream();
    }, delay);
  }

  private scheduleRestart(delay: number): void {
    if (this.stopped || this.quotaPaused || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  private trimSeen(): void {
    if (this.seen.size <= 5000) return;
    this.seen = new Set([...this.seen].slice(-2500));
  }

  private status(state: PlatformStatus["state"], detail: string, channel?: string): void {
    this.emitStatus({ platform: "youtube", state, detail, channel, updatedAt: Date.now() });
  }
}

export function buildYouTubeAuthorizeUrl(config: ReturnType<ConfigStore["get"]>["youtube"], redirectUri: string, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.oauthClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.force-ssl");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeYouTubeCode(config: ReturnType<ConfigStore["get"]>["youtube"], code: string, redirectUri: string): Promise<any> {
  const body = new URLSearchParams({
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!response.ok) throw new Error(`OAuth YouTube ${response.status}: ${await response.text()}`);
  return response.json();
}

function youtubeEventInfo(type: string, snippet: any): {
  category: "membership" | "gift" | "superchat" | "supersticker" | "other";
  style: string;
  text: string;
  metadata?: Record<string, unknown>;
} | null {
  switch (type) {
    case "NEW_SPONSOR_EVENT": {
      const info = snippet.newSponsorDetails ?? {};
      const level = String(info.memberLevelName || "").trim();
      const text = info.isUpgrade
        ? `a amélioré son niveau de membre${level ? ` vers « ${level} »` : ""} !`
        : `est devenu membre${level ? ` (« ${level} »)` : ""} !`;
      return { category: "membership", style: "membership", text, metadata: { level, isUpgrade: Boolean(info.isUpgrade) } };
    }
    case "MEMBER_MILESTONE_CHAT_EVENT": {
      const info = snippet.memberMilestoneChatDetails ?? {};
      const months = Number(info.memberMonth || 0);
      const level = String(info.memberLevelName || "").trim();
      const comment = String(info.userComment || "").trim();
      const text = `célèbre ${months || "plusieurs"} mois de membership${level ? ` (« ${level} »)` : ""} !${comment ? ` — ${comment}` : ""}`;
      return { category: "membership", style: "membership-milestone", text, metadata: { months, level, comment } };
    }
    case "MEMBERSHIP_GIFTING_EVENT": {
      const info = snippet.membershipGiftingDetails ?? {};
      const count = Number(info.giftMembershipsCount || 0);
      const level = String(info.giftMembershipsLevelName || "").trim();
      const text = `a offert ${count || "plusieurs"} membership${count === 1 ? "" : "s"}${level ? ` « ${level} »` : ""} !`;
      return { category: "gift", style: "youtube-gift", text, metadata: { count, level } };
    }
    case "GIFT_MEMBERSHIP_RECEIVED_EVENT": {
      const info = snippet.giftMembershipReceivedDetails ?? {};
      const level = String(info.memberLevelName || "").trim();
      const text = `a reçu un membership offert${level ? ` « ${level} »` : ""} !`;
      return { category: "gift", style: "youtube-gift-received", text, metadata: { level, gifterChannelId: info.gifterChannelId } };
    }
    case "SUPER_CHAT_EVENT": {
      const info = snippet.superChatDetails ?? {};
      const amount = String(info.amountDisplayString || "").trim();
      const comment = String(info.userComment || snippet.displayMessage || "").trim();
      const tier = Math.max(1, Number(info.tier || 1));
      const text = `a envoyé un Super Chat${amount ? ` de ${amount}` : ""} !${comment ? ` — ${comment}` : ""}`;
      return { category: "superchat", style: `superchat-tier${tier}`, text, metadata: { amount, tier, amountMicros: info.amountMicros, currency: info.currency } };
    }
    case "SUPER_STICKER_EVENT": {
      const info = snippet.superStickerDetails ?? {};
      const amount = String(info.amountDisplayString || "").trim();
      const altText = String(info.superStickerMetadata?.altText || "").trim();
      const tier = Math.max(1, Number(info.tier || 1));
      const text = `a envoyé un Super Sticker${amount ? ` de ${amount}` : ""} !${altText ? ` — ${altText}` : ""}`;
      return { category: "supersticker", style: `supersticker-tier${tier}`, text, metadata: { amount, tier, stickerId: info.superStickerMetadata?.stickerId, altText } };
    }
    default:
      return null;
  }
}

async function youtubeRestError(prefix: string, response: Response): Promise<Error> {
  const text = await response.text();
  let reason = "";
  let message = "";
  try {
    const parsed = JSON.parse(text);
    reason = parsed?.error?.errors?.[0]?.reason || parsed?.error?.status || "";
    message = parsed?.error?.message || "";
  } catch {
    // Réponse non JSON : on utilisera le texte brut ci-dessous.
  }

  if (reason === "quotaExceeded" || /quotaExceeded|exceeded.*quota/i.test(text)) {
    return new YouTubeQuotaError("Quota YouTube épuisé");
  }

  const clean = message || text || response.statusText;
  return new Error(`${prefix} ${response.status}: ${clean}`);
}

function cleanGrpcDetail(value: unknown): string {
  const text = String(value ?? "Erreur inconnue").replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

function friendlyError(error: unknown): string {
  if (error instanceof YouTubeQuotaError) return "Quota YouTube épuisé";
  return error instanceof Error ? error.message : String(error);
}
