import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { makeFakeBits, makeFakeMessage, makeFakeReward, makeFakeTwitchEvent, makeFakeTwitchResub } from "./fakeMessages.js";
import { ConfigStore } from "./config.js";
import { IntegrationManager } from "./integrations/manager.js";
import { buildTwitchAuthorizeUrl, exchangeTwitchCode } from "./integrations/twitch.js";
import { buildYouTubeAuthorizeUrl, exchangeYouTubeCode } from "./integrations/youtube.js";
import type { ChatMessage, ChatPlatform, ClientEvent, PlatformStatus } from "./types.js";

const PORT = Number(process.env.PORT ?? 4242);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const packageInfo = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const APP_VERSION = String(packageInfo.version || "dev");
const configStore = new ConfigStore(path.join(rootDir, "data", "config.json"));

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));

app.get("/overlay/feed", (_req, res) => {
  res.sendFile(path.join(publicDir, "overlay.html"));
});

app.get("/chat", (_req, res) => {
  res.sendFile(path.join(publicDir, "chat-console.html"));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const statuses = new Map<ChatPlatform, PlatformStatus>();
const chatHistory: ChatMessage[] = [];
const oauthStates = new Map<string, { platform: "twitch" | "youtube"; expiry: number }>();

function broadcast(event: ClientEvent): void {
  const json = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
}

function setStatus(status: PlatformStatus): void {
  statuses.set(status.platform, status);
  broadcast({ type: "platform-status", payload: status });
}

function emitChatMessage(message: ChatMessage): void {
  chatHistory.push(message);
  broadcast({ type: "chat-message", payload: message });
}

const integrations = new IntegrationManager(
  configStore,
  emitChatMessage,
  setStatus
);

function emitFake(platform?: ChatPlatform, text?: string) {
  const message = makeFakeMessage(platform, text);
  emitChatMessage(message);
  return message;
}

app.get("/api/chat-history", (_req, res) => {
  res.json({ ok: true, messages: chatHistory });
});

app.get("/api/overlay-settings", (_req, res) => {
  res.json({ ok: true, eventAnimation: configStore.publicView().overlay.eventAnimation });
});

app.post("/api/overlay-settings", (req, res) => {
  try {
    configStore.updatePublic({ overlay: req.body?.reset === true
      ? { resetEventAnimation: true }
      : { eventAnimation: req.body?.eventAnimation ?? {} }
    });
    const eventAnimation = configStore.publicView().overlay.eventAnimation;
    broadcast({ type: "overlay-settings", payload: eventAnimation });
    res.json({ ok: true, eventAnimation });
  } catch (error) {
    res.status(400).json({ ok: false, error: formatError(error) });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    config: configStore.publicView(),
    statuses: Object.fromEntries(statuses.entries()),
    capabilities: integrations.capabilities(),
    urls: {
      overlay: `${PUBLIC_BASE_URL}/overlay/feed`,
      persist: `${PUBLIC_BASE_URL}/overlay/feed?persist=1&limit=8`,
      chat: `${PUBLIC_BASE_URL}/chat`
    }
  });
});

app.post("/api/config", async (req, res) => {
  try {
    configStore.updatePublic(req.body);
    await integrations.restart();
    res.json({ ok: true, config: configStore.publicView() });
  } catch (error) {
    res.status(400).json({ ok: false, error: formatError(error) });
  }
});

app.post("/api/restart-integrations", async (_req, res) => {
  await integrations.restart();
  res.json({ ok: true });
});

app.get("/auth/twitch/start", (req, res) => {
  const cfg = configStore.get().twitch;
  if (!cfg.clientId || !cfg.clientSecret) {
    return res.redirect("/?twitchError=" + encodeURIComponent("Renseigne d'abord le Client ID et le Client Secret Twitch."));
  }
  const state = randomBytes(24).toString("hex");
  oauthStates.set(state, { platform: "twitch", expiry: Date.now() + 10 * 60_000 });
  const redirectUri = `${PUBLIC_BASE_URL}/auth/twitch/callback`;
  res.redirect(buildTwitchAuthorizeUrl(cfg, redirectUri, state));
});

app.get("/auth/twitch/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const denied = typeof req.query.error === "string" ? req.query.error : "";
  const oauthState = oauthStates.get(state);
  oauthStates.delete(state);

  if (denied) return res.redirect("/?twitchError=" + encodeURIComponent(`Autorisation refusée : ${denied}`));
  if (!state || !oauthState || oauthState.platform !== "twitch" || oauthState.expiry < Date.now() || !code) {
    return res.redirect("/?twitchError=" + encodeURIComponent("Réponse OAuth Twitch invalide ou expirée."));
  }

  try {
    const cfg = configStore.get().twitch;
    const redirectUri = `${PUBLIC_BASE_URL}/auth/twitch/callback`;
    const tokens = await exchangeTwitchCode(cfg, code, redirectUri);
    configStore.setTwitchTokens(tokens.access_token, tokens.refresh_token ?? "");
    await integrations.restartTwitch();
    res.redirect("/?twitchConnected=1");
  } catch (error) {
    res.redirect("/?twitchError=" + encodeURIComponent(formatError(error)));
  }
});

app.get("/auth/youtube/start", (req, res) => {
  const cfg = configStore.get().youtube;
  if (!cfg.oauthClientId || !cfg.oauthClientSecret) {
    return res.redirect("/?youtubeError=" + encodeURIComponent("Renseigne d'abord le Client ID OAuth et le Client Secret YouTube."));
  }
  const state = randomBytes(24).toString("hex");
  oauthStates.set(state, { platform: "youtube", expiry: Date.now() + 10 * 60_000 });
  const redirectUri = `${PUBLIC_BASE_URL}/auth/youtube/callback`;
  res.redirect(buildYouTubeAuthorizeUrl(cfg, redirectUri, state));
});

app.get("/auth/youtube/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const denied = typeof req.query.error === "string" ? req.query.error : "";
  const oauthState = oauthStates.get(state);
  oauthStates.delete(state);

  if (denied) return res.redirect("/?youtubeError=" + encodeURIComponent(`Autorisation refusée : ${denied}`));
  if (!state || !oauthState || oauthState.platform !== "youtube" || oauthState.expiry < Date.now() || !code) {
    return res.redirect("/?youtubeError=" + encodeURIComponent("Réponse OAuth YouTube invalide ou expirée."));
  }

  try {
    const cfg = configStore.get().youtube;
    const redirectUri = `${PUBLIC_BASE_URL}/auth/youtube/callback`;
    const tokens = await exchangeYouTubeCode(cfg, code, redirectUri);
    configStore.setYouTubeOAuthTokens(tokens.access_token, tokens.refresh_token ?? "", tokens.expires_in);
    res.redirect("/?youtubeConnected=1");
  } catch (error) {
    res.redirect("/?youtubeError=" + encodeURIComponent(formatError(error)));
  }
});

app.post("/api/youtube/disconnect", async (_req, res) => {
  configStore.clearYouTubeOAuthTokens();
  res.json({ ok: true });
});

app.post("/api/twitch/disconnect", async (_req, res) => {
  configStore.clearTwitchTokens();
  await integrations.restartTwitch();
  res.json({ ok: true });
});

app.post("/api/send-chat", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const rawTargets = Array.isArray(req.body?.targets) ? req.body.targets : [];
  const targets = [...new Set(rawTargets.filter((value: unknown) => value === "twitch" || value === "youtube"))] as Array<"twitch" | "youtube">;

  if (!message) return res.status(400).json({ ok: false, error: "Écris un message avant de l’envoyer." });
  if (!targets.length) return res.status(400).json({ ok: false, error: "Choisis Twitch, YouTube ou les deux." });

  const results = await integrations.sendChat(targets, message);
  const ok = targets.every((target) => results[target]?.ok);
  res.status(ok ? 200 : 207).json({ ok, results });
});

app.post("/api/test-message", (req, res) => {
  const rawPlatform = req.body?.platform;
  const platform: ChatPlatform | undefined = rawPlatform === "twitch" || rawPlatform === "youtube" ? rawPlatform : undefined;
  const text = typeof req.body?.text === "string" ? req.body.text : undefined;
  const first = req.body?.first === "stream" || req.body?.first === "ever" ? req.body.first : undefined;
  const message = makeFakeMessage(platform, text, first);
  emitChatMessage(message);
  res.json({ ok: true, message });
});

app.post("/api/test-event", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : undefined;
  const style = typeof req.body?.style === "string" ? req.body.style : "resub-tier1";
  const message = makeFakeTwitchEvent(style, text);
  emitChatMessage(message);
  res.json({ ok: true, message });
});

app.post("/api/test-reward", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : undefined;
  const message = makeFakeReward(text);
  emitChatMessage(message);
  res.json({ ok: true, message });
});

app.post("/api/test-bits", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : undefined;
  const bits = Number(req.body?.bits || 1000);
  const message = makeFakeBits(text, bits);
  emitChatMessage(message);
  res.json({ ok: true, message });
});

app.post("/api/test-resub", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : undefined;
  const message = makeFakeTwitchResub(text);
  emitChatMessage(message);
  res.json({ ok: true, message });
});

let autoTimer: ReturnType<typeof setTimeout> | null = null;
app.post("/api/auto/start", (_req, res) => {
  if (!autoTimer) {
    const tick = () => {
      emitFake();
      autoTimer = setTimeout(tick, 1200 + Math.round(Math.random() * 2400));
    };
    tick();
  }
  res.json({ ok: true, active: true });
});

app.post("/api/auto/stop", (_req, res) => {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
  res.json({ ok: true, active: false });
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello", payload: { connected: true, version: APP_VERSION } }));
  for (const status of statuses.values()) {
    socket.send(JSON.stringify({ type: "platform-status", payload: status }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nOBS Chat Prototype V${APP_VERSION}`);
  console.log(`Dashboard : http://${HOST}:${PORT}/`);
  console.log(`Console   : http://${HOST}:${PORT}/chat`);
  console.log(`Overlay   : http://${HOST}:${PORT}/overlay/feed`);
  console.log(`Persist   : http://${HOST}:${PORT}/overlay/feed?persist=1\n`);
  void integrations.restart();
});

process.on("SIGINT", () => {
  integrations.stop();
  server.close(() => process.exit(0));
});

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
