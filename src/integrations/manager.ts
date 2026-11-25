import type { ConfigStore } from "../config.js";
import type { ChatMessage, PlatformStatus } from "../types.js";
import { TwitchIntegration } from "./twitch.js";
import { YouTubeIntegration } from "./youtube.js";

export class IntegrationManager {
  private readonly twitch: TwitchIntegration;
  private readonly youtube: YouTubeIntegration;

  constructor(
    config: ConfigStore,
    emitMessage: (message: ChatMessage) => void,
    emitStatus: (status: PlatformStatus) => void
  ) {
    this.twitch = new TwitchIntegration(config, emitMessage, emitStatus);
    this.youtube = new YouTubeIntegration(config, emitMessage, emitStatus);
  }

  async restart(): Promise<void> {
    this.twitch.stop();
    this.youtube.stop();
    await Promise.allSettled([this.twitch.start(), this.youtube.start()]);
  }

  async restartTwitch(): Promise<void> {
    this.twitch.stop();
    await this.twitch.start();
  }

  async restartYouTube(): Promise<void> {
    this.youtube.stop();
    await this.youtube.start();
  }

  capabilities(): { twitchSend: boolean; youtubeSend: boolean; twitchRewards: boolean } {
    return {
      twitchSend: this.twitch.canSend(),
      youtubeSend: this.youtube.canSend(),
      twitchRewards: this.twitch.canReceiveRewards()
    };
  }

  async sendChat(targets: Array<"twitch" | "youtube">, message: string): Promise<Record<string, { ok: boolean; detail: string }>> {
    const result: Record<string, { ok: boolean; detail: string }> = {};
    await Promise.all(targets.map(async (target) => {
      try {
        if (target === "twitch") await this.twitch.sendMessage(message);
        else await this.youtube.sendMessage(message);
        result[target] = { ok: true, detail: "Message envoyé" };
      } catch (error) {
        result[target] = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }));
    return result;
  }

  stop(): void {
    this.twitch.stop();
    this.youtube.stop();
  }
}
