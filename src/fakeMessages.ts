import type { ChatMessage, ChatPlatform } from "./types.js";

const twitchUsers: Array<{ name: string; color?: string }> = [
  { name: "JeanMichel", color: "#26c96f" },
  { name: "PixelMage", color: "#ff69b4" },
  { name: "NoScopeCroissant", color: "#54a9ff" },
  { name: "MisterPoulpe", color: "#f0b64a" }
];

const youtubeUsers: Array<{ name: string; color?: string }> = [
  { name: "RogerDu75" },
  { name: "LeCoinDuGeek" },
  { name: "NinaPlays" },
  { name: "CaptainPixel" }
];

const texts = [
  "Salut tout le monde ! 👋",
  "T'as oublié le coffre derrière toi 😄",
  "GG !",
  "Nan mais ce boss est complètement pété 😂",
  "Je viens d'arriver, j'ai raté quoi ?",
  "Alors j'ai testé le truc dont tu parlais hier et effectivement ça marche beaucoup mieux comme ça.",
  "Pour le prochain live tu comptes continuer celui-là ou partir sur autre chose ?",
  "Incroyable cette action 🔥🔥🔥",
  "Ça rend super bien à l'écran, surtout avec les messages qui disparaissent progressivement."
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function makeFakeMessage(platform?: ChatPlatform, customText?: string, first?: "stream" | "ever"): ChatMessage {
  const resolvedPlatform = platform ?? (Math.random() > 0.5 ? "twitch" : "youtube");
  const user = pick(resolvedPlatform === "twitch" ? twitchUsers : youtubeUsers);
  const isMod = Math.random() > 0.72;
  const isSub = Math.random() > 0.45;
  const isVerified = resolvedPlatform === "youtube" && Math.random() > 0.88;
  const text = customText?.trim() || pick(texts);

  const badges: ChatMessage["author"]["badges"] = [];
  if (isMod) badges.push({
    id: "moderator",
    label: "Modérateur",
    imageUrl: resolvedPlatform === "twitch" ? "/assets/badges/twitch-moderator.svg" : "/assets/badges/youtube-moderator.svg",
    title: "Modérateur"
  });
  if (isSub) badges.push({
    id: "subscriber",
    label: resolvedPlatform === "twitch" ? "Subscriber" : "Member",
    imageUrl: resolvedPlatform === "twitch" ? "/assets/badges/twitch-subscriber.svg" : "/assets/badges/youtube-member.svg",
    title: resolvedPlatform === "twitch" ? "Abonné Twitch (simulation)" : "Membre YouTube (simulation)"
  });
  if (isVerified) badges.push({
    id: "verified",
    label: "Vérifié",
    imageUrl: "/assets/badges/youtube-verified.svg",
    title: "Compte vérifié"
  });

  return {
    id: `${resolvedPlatform}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    platform: resolvedPlatform,
    kind: "chat",
    eventCategory: "chat",
    author: {
      id: `fake-${user.name.toLowerCase()}`,
      name: user.name,
      color: user.color,
      badges,
      roles: {
        moderator: isMod,
        subscriber: isSub,
        verified: isVerified
      }
    },
    content: {
      text,
      fragments: [{ type: "text", text }]
    },
    flags: resolvedPlatform === "twitch" && first ? {
      firstMessageThisStream: true,
      firstMessageEver: first === "ever"
    } : undefined,
    timestamp: Date.now()
  };
}

export function makeFakeTwitchResub(customText?: string): ChatMessage {
  const text = customText?.trim() || "Toujours là après 15 mois ! PogChamp";
  return {
    id: `twitch-resub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    platform: "twitch",
    kind: "event",
    eventType: "resub",
    eventCategory: "resub",
    eventStyle: "resub-tier1",
    author: {
      id: "fake-resub-jeanmichel",
      name: "JeanMichel",
      color: "#26c96f",
      badges: [{
        id: "subscriber:12",
        label: "Subscriber",
        imageUrl: "/assets/badges/twitch-subscriber.svg",
        title: "Badge subscriber simulé — en réel l'asset exact vient de Twitch"
      }],
      roles: { subscriber: true }
    },
    content: {
      text: `s'est réabonné pour son 15e mois (Tier 1) ! — ${text}`,
      fragments: [{ type: "text", text: `s'est réabonné pour son 15e mois (Tier 1) ! — ${text}` }]
    },
    timestamp: Date.now()
  };
}


export function makeFakeTwitchEvent(style = "resub-tier1", customText?: string): ChatMessage {
  const presets: Record<string, { eventType: string; text: string }> = {
    "sub-prime": { eventType: "sub", text: "s'est abonné avec Prime !" },
    "sub-tier1": { eventType: "sub", text: "s'est abonné (Tier 1) !" },
    "sub-tier2": { eventType: "sub", text: "s'est abonné (Tier 2) !" },
    "sub-tier3": { eventType: "sub", text: "s'est abonné (Tier 3) !" },
    "resub-tier1": { eventType: "resub", text: "s'est réabonné pour son 15e mois (Tier 1) !" },
    "resub-tier2": { eventType: "resub", text: "s'est réabonné pour son 15e mois (Tier 2) !" },
    "resub-tier3": { eventType: "resub", text: "s'est réabonné pour son 15e mois (Tier 3) !" },
    "community-gift-tier1": { eventType: "community_sub_gift", text: "a offert 5 abonnements Tier 1 à la communauté !" },
    "community-gift-tier2": { eventType: "community_sub_gift", text: "a offert 5 abonnements Tier 2 à la communauté !" },
    "community-gift-tier3": { eventType: "community_sub_gift", text: "a offert 5 abonnements Tier 3 à la communauté !" }
  };
  const preset = presets[style] || presets["resub-tier1"];
  const suffix = customText?.trim();
  const text = suffix ? `${preset.text} — ${suffix}` : preset.text;
  return {
    id: `twitch-event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    platform: "twitch",
    kind: "event",
    eventType: preset.eventType,
    eventCategory: preset.eventType === "sub" ? "sub" : preset.eventType === "resub" ? "resub" : "gift",
    eventStyle: style,
    author: {
      id: "fake-event-jeanmichel",
      name: "JeanMichel",
      color: "#26c96f",
      badges: [{
        id: "subscriber:12", label: "Subscriber", imageUrl: "/assets/badges/twitch-subscriber.svg",
        title: "Badge subscriber simulé — en réel l'asset exact vient de Twitch"
      }],
      roles: { subscriber: true }
    },
    content: { text, fragments: [{ type: "text", text }] },
    timestamp: Date.now()
  };
}


export function makeFakeReward(customText?: string): ChatMessage {
  const userInput = customText?.trim() || "Le couteau";
  const title = "Choisis mon arme";
  const cost = 5000;
  const text = `a utilisé « ${title} » (${cost.toLocaleString("fr-FR")} pts) : ${userInput}`;
  return {
    id: `twitch-reward-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    platform: "twitch",
    kind: "event",
    eventType: "reward",
    eventCategory: "reward",
    eventStyle: "reward",
    author: {
      id: "fake-reward-pixelmage",
      name: "PixelMage",
      color: "#ff69b4",
      badges: [],
      roles: {}
    },
    content: { text, fragments: [{ type: "text", text }] },
    metadata: { rewardTitle: title, rewardCost: cost, userInput },
    timestamp: Date.now()
  };
}


function bitsTier(bits: number): number {
  if (bits >= 100000) return 100000;
  if (bits >= 10000) return 10000;
  if (bits >= 5000) return 5000;
  if (bits >= 1000) return 1000;
  if (bits >= 100) return 100;
  return 1;
}

export function makeFakeBits(customText?: string, rawBits?: number): ChatMessage {
  const bits = Math.max(1, Math.round(Number(rawBits) || 1000));
  const tier = bitsTier(bits);
  const viewerText = customText?.trim() || 'GG, énorme !';
  const text = `a envoyé ${bits.toLocaleString("fr-FR")} Bits ! — ${viewerText}`;
  return {
    id: `twitch-bits-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    platform: "twitch",
    kind: "event",
    eventType: "cheer",
    eventCategory: "bits",
    eventStyle: `bits-tier${tier}`,
    author: {
      id: "fake-bits-neonraven",
      name: "NeonRaven",
      color: "#7aa7ff",
      badges: [],
      roles: {}
    },
    content: { text, fragments: [{ type: "text", text }] },
    metadata: { bits, cheermoteTier: tier },
    timestamp: Date.now()
  };
}
