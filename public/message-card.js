import { DEFAULT_EVENT_ANIMATION, normalizeEventAnimation } from './animation-settings.js';

function platformBadge(platform) {
  const badge = document.createElement('span');
  badge.className = `platform-badge ${platform}`;
  badge.title = platform === 'twitch' ? 'Twitch' : 'YouTube';
  badge.setAttribute('aria-label', badge.title);

  if (platform === 'twitch') {
    const img = document.createElement('img');
    img.className = 'platform-logo';
    img.src = '/assets/platforms/twitch.svg';
    img.alt = '';
    img.loading = 'eager';
    badge.append(img);
  } else {
    const play = document.createElement('span');
    play.className = 'yt-play';
    badge.append(play);
  }
  return badge;
}

function viewerBadge(data) {
  const badge = document.createElement('span');
  badge.className = 'viewer-badge';
  if (data.title) badge.title = data.title;

  if (data.imageUrl) {
    badge.classList.add('has-image');
    const img = document.createElement('img');
    img.src = data.imageUrl;
    img.alt = data.label || 'Badge';
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      badge.classList.remove('has-image');
      img.remove();
      badge.textContent = data.label?.slice(0, 4) || '•';
    });
    badge.append(img);
  } else {
    badge.textContent = data.label?.slice(0, 4) || '•';
  }
  return badge;
}

function fragmentNode(fragment) {
  if (fragment.type === 'emote' && fragment.imageUrl) {
    const img = document.createElement('img');
    img.className = 'emote';
    img.src = fragment.imageUrl;
    img.alt = fragment.text;
    img.loading = 'eager';
    return img;
  }
  return document.createTextNode(fragment.text);
}

export function animationKindFor(messageOrRoot) {
  const category = String(
    messageOrRoot?.eventCategory || messageOrRoot?.dataset?.eventCategory || ''
  ).toLowerCase();
  if (category === 'reward') return 'static';
  if (category === 'bits') return 'bits';
  return 'orbit';
}

export function clearBitsPulse(root) {
  if (!root) return;
  if (root.__bitsPulseTimer) clearTimeout(root.__bitsPulseTimer);
  delete root.__bitsPulseTimer;
  root.classList.remove('bits-pulse-active');
}

export function destroyMessageCardAnimation(root) {
  if (!root) return;
  window.EventGlowLite?.destroy(root);
  clearBitsPulse(root);
}

function glowOptions(settings, durationMs) {
  const animation = normalizeEventAnimation(settings);
  return {
    durationMs,
    fps: animation.fps,
    trailLength: animation.trailLength,
    orbitDuration: animation.orbitDuration,
    orbSize: animation.orbSize,
    glowIntensity: animation.glowIntensity,
    canvasPadding: 32,
    animate: true
  };
}

function startBitsPulse(root, durationMs) {
  clearBitsPulse(root);
  if (durationMs <= 0) return;
  root.classList.add('bits-pulse-active');
  root.__bitsPulseTimer = setTimeout(() => {
    root.classList.remove('bits-pulse-active');
    delete root.__bitsPulseTimer;
  }, durationMs);
}

export function remainingAnimationDuration(root, settings = {}) {
  const animation = normalizeEventAnimation(settings);
  const now = performance.now();
  const startedAt = Number(root?.__eventAnimationStartedAt ?? now);
  return Math.max(0, animation.eventDuration - (now - startedAt));
}

export function startMessageCardAnimation(root, {
  settings = DEFAULT_EVENT_ANIMATION,
  enabled = true,
  durationMs = null,
  restartClock = false
} = {}) {
  if (!root || !root.classList.contains('event')) return;

  destroyMessageCardAnimation(root);
  const animation = normalizeEventAnimation(settings);
  const now = performance.now();
  if (restartClock || !Number.isFinite(Number(root.__eventAnimationStartedAt))) {
    root.__eventAnimationStartedAt = now;
  }

  if (!enabled) return;
  const kind = animationKindFor(root);
  if (kind === 'static') return;

  const effectiveDuration = durationMs == null
    ? Math.max(0, animation.eventDuration - (now - Number(root.__eventAnimationStartedAt)))
    : Math.max(0, Number(durationMs));
  if (effectiveDuration <= 0) return;

  if (kind === 'bits') {
    startBitsPulse(root, effectiveDuration);
    return;
  }

  requestAnimationFrame(() => {
    if (!root.isConnected || root.closest('.leaving')) return;
    window.EventGlowLite?.attach(root, glowOptions(animation, effectiveDuration));
  });
}

export function applyAnimationSettingsToCards(cards, settings, {
  enabled = true,
  restartCurrent = false
} = {}) {
  const animation = normalizeEventAnimation(settings);
  for (const root of cards ?? []) {
    if (!root?.classList?.contains('event')) continue;
    const durationMs = restartCurrent
      ? animation.eventDuration
      : remainingAnimationDuration(root, animation);
    startMessageCardAnimation(root, {
      settings: animation,
      enabled,
      durationMs,
      restartClock: restartCurrent
    });
  }
}

export function createMessageCard(message, {
  showTimestamp = false,
  showPlatformBadge = true,
  tint = true,
  animateEvent = true,
  animationsEnabled = true,
  animationSettings = DEFAULT_EVENT_ANIMATION
} = {}) {
  const root = document.createElement('article');
  root.className = 'message-card';
  root.dataset.id = message.id;
  root.dataset.platform = message.platform;

  if (message.kind === 'event') root.classList.add('event');
  if (message.eventType) root.dataset.eventType = message.eventType;
  if (message.eventCategory) root.dataset.eventCategory = message.eventCategory;
  if (message.eventStyle) root.dataset.eventStyle = message.eventStyle;
  if (message.flags?.firstMessageThisStream) root.classList.add('first-message-stream');
  if (message.flags?.firstMessageEver) root.classList.add('first-message-ever');
  if (!tint) root.classList.add('no-tint');

  const line = document.createElement('div');
  line.className = 'message-card-line';

  if (showTimestamp) {
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = new Date(message.timestamp).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    line.append(time);
  }

  if (showPlatformBadge) line.append(platformBadge(message.platform));
  for (const badge of message.author.badges ?? []) line.append(viewerBadge(badge));

  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = message.author.name;
  if (message.author.color) author.style.color = message.author.color;
  line.append(author);

  const separator = document.createElement('span');
  separator.className = 'separator';
  separator.textContent = ' : ';
  line.append(separator);

  const content = document.createElement('span');
  content.className = 'content';
  for (const fragment of message.content.fragments ?? [{ type: 'text', text: message.content.text }]) {
    content.append(fragmentNode(fragment));
  }
  line.append(content);
  root.append(line);

  if (message.kind === 'event') {
    root.__eventAnimationStartedAt = performance.now();
    if (animateEvent) {
      startMessageCardAnimation(root, {
        settings: animationSettings,
        enabled: animationsEnabled,
        durationMs: normalizeEventAnimation(animationSettings).eventDuration
      });
    }
  }

  return root;
}
