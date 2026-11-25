import {
  DEFAULT_EVENT_ANIMATION,
  applyAnimationUrlOverrides,
  loadEventAnimationSettings,
  normalizeEventAnimation
} from './animation-settings.js';
import {
  applyAnimationSettingsToCards,
  createMessageCard,
  destroyMessageCardAnimation
} from './message-card.js';

const params = new URLSearchParams(location.search);
const feed = document.querySelector('#feed');
const timers = new Map();

const config = {
  persist: params.get('persist') === '1',
  limit: clampInt(params.get('limit'), 1, 30, 5),
  baseMs: clampInt(params.get('base'), 0, 60000, 2500),
  perWordMs: clampInt(params.get('perWord'), 0, 5000, 260),
  minMs: clampInt(params.get('minDuration'), 500, 60000, 4000),
  maxMs: clampInt(params.get('maxDuration'), 500, 120000, 12000),
  tint: params.get('tint') !== '0',
  platformBadge: params.get('platformBadge') !== '0',
  platforms: parseFilter(params.get('platform')),
  events: parseFilter(params.get('events')),
  animationsEnabled: params.get('animations') !== '0',
  animation: { ...DEFAULT_EVENT_ANIMATION }
};

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseFilter(value) {
  if (!value || value.trim().toLowerCase() === 'all') return null;
  const set = new Set(value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
}

function durationFor(message) {
  const wordCount = message.content.text.trim().split(/\s+/).filter(Boolean).length;
  if (message.kind === 'event') return config.animation.eventDuration;
  const raw = config.baseMs + wordCount * config.perWordMs;
  return Math.min(config.maxMs, Math.max(config.minMs, raw));
}

function passesFilters(message) {
  if (config.platforms && !config.platforms.has(String(message.platform || '').toLowerCase())) return false;
  if (!config.events) return true;

  const category = String(message.eventCategory || (message.kind === 'event' ? 'other' : 'chat')).toLowerCase();
  const type = String(message.eventType || '').toLowerCase();
  const style = String(message.eventStyle || '').toLowerCase();
  if (config.events.has(category) || (type && config.events.has(type)) || (style && config.events.has(style))) return true;
  if (config.events.has('event') && message.kind === 'event') return true;
  if (config.events.has('subscription') && ['sub', 'resub', 'gift', 'membership'].includes(category)) return true;
  return false;
}

function activeEventCards() {
  return feed.querySelectorAll('.feed-message-slot:not(.leaving) > .message-card.event');
}

function setAnimationsEnabled(enabled, { restartCurrent = false } = {}) {
  config.animationsEnabled = Boolean(enabled);
  applyAnimationSettingsToCards(activeEventCards(), config.animation, {
    enabled: config.animationsEnabled,
    restartCurrent
  });
}

function applyLiveAnimationSettings(settings) {
  // La config serveur est la source de vérité. Les paramètres URL restent la seule
  // surcharge locale volontaire pour cette Browser Source précise.
  config.animation = applyAnimationUrlOverrides(normalizeEventAnimation(settings), params);
  applyAnimationSettingsToCards(activeEventCards(), config.animation, {
    enabled: config.animationsEnabled,
    restartCurrent: false
  });
}

function createFeedSlot(message) {
  const slot = document.createElement('div');
  slot.className = 'feed-message-slot';
  slot.dataset.id = message.id;

  slot.append(createMessageCard(message, {
    showTimestamp: false,
    showPlatformBadge: config.platformBadge,
    tint: config.tint,
    animateEvent: true,
    animationsEnabled: config.animationsEnabled,
    animationSettings: config.animation
  }));
  return slot;
}

function removeMessage(slot) {
  if (!slot || slot.classList.contains('leaving')) return;
  const id = slot.dataset.id;
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);

  const card = slot.querySelector('.message-card');
  const height = Math.ceil(slot.getBoundingClientRect().height);
  slot.style.setProperty('--message-exit-height', `${Math.max(1, height)}px`);
  slot.style.maxHeight = `${Math.max(1, height)}px`;
  void slot.offsetHeight;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    destroyMessageCardAnimation(card);
    slot.remove();
  };

  slot.addEventListener('animationend', (event) => {
    if (event.target === slot && event.animationName === 'feed-message-out') cleanup();
  }, { once: true });

  slot.classList.add('leaving');
  setTimeout(cleanup, 450);
}

function enforceLimit() {
  const active = [...feed.querySelectorAll('.feed-message-slot:not(.leaving)')];
  while (active.length > config.limit) removeMessage(active.shift());
}

function addMessage(message) {
  if (!passesFilters(message)) return;
  const slot = createFeedSlot(message);
  feed.append(slot);
  enforceLimit();

  if (!config.persist) {
    const timer = setTimeout(() => removeMessage(slot), durationFor(message));
    timers.set(message.id, timer);
  }
}

function handleServerVersion(version) {
  if (!version) return false;
  const key = 'obs-chat-server-version';
  const previous = sessionStorage.getItem(key);
  sessionStorage.setItem(key, String(version));
  if (previous && previous !== String(version)) {
    location.reload();
    return true;
  }
  return false;
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'hello' && handleServerVersion(data.payload?.version)) return;
    if (data.type === 'chat-message') addMessage(data.payload);
    if (data.type === 'overlay-settings') applyLiveAnimationSettings(data.payload);
  });
  ws.addEventListener('close', () => setTimeout(connect, 1200));
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (data?.type === 'overlay-preview-animations') {
    setAnimationsEnabled(Boolean(data.enabled), { restartCurrent: Boolean(data.enabled) });
  }
});

async function init() {
  config.animation = applyAnimationUrlOverrides(await loadEventAnimationSettings(), params);
  connect();
}

void init();
