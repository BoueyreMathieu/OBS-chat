import {
  DEFAULT_EVENT_ANIMATION,
  loadEventAnimationSettings,
  normalizeEventAnimation
} from './animation-settings.js';
import {
  applyAnimationSettingsToCards,
  createMessageCard,
  destroyMessageCardAnimation
} from './message-card.js';

const log = document.querySelector('#chatLog');
const emptyState = document.querySelector('#emptyState');
const input = document.querySelector('#chatInput');
const sendStatus = document.querySelector('#sendStatus');
const charCount = document.querySelector('#charCount');
const newMessagesButton = document.querySelector('#newMessages');
const connectionState = document.querySelector('#connectionState');
const sendTwitch = document.querySelector('#sendTwitch');
const sendYouTube = document.querySelector('#sendYouTube');
const sendBoth = document.querySelector('#sendBoth');
const sendNow = document.querySelector('#sendNow');

const messages = new Map();
let historyLoaded = false;
let unseen = 0;
let socket = null;
let targetsInitialized = false;
let eventAnimation = { ...DEFAULT_EVENT_ANIMATION };
const chatParams = new URLSearchParams(location.search);
const animationsEnabled = chatParams.get('animations') !== '0';

function isNearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 90;
}

function scrollBottom() {
  log.scrollTop = log.scrollHeight;
  unseen = 0;
  newMessagesButton.hidden = true;
}

function buildCard(message, animateEvent = true) {
  return createMessageCard(message, {
    showTimestamp: true,
    showPlatformBadge: true,
    tint: true,
    animateEvent,
    animationsEnabled,
    animationSettings: eventAnimation
  });
}

function appendMessage(message, forceScroll = false) {
  if (!message?.id || messages.has(message.id)) return false;
  const shouldFollow = forceScroll || isNearBottom();
  messages.set(message.id, message);
  emptyState?.remove();
  log.append(buildCard(message, true));

  if (shouldFollow) scrollBottom();
  else {
    unseen += 1;
    newMessagesButton.textContent = `${unseen} nouveau${unseen > 1 ? 'x' : ''} message${unseen > 1 ? 's' : ''}`;
    newMessagesButton.hidden = false;
  }
  return true;
}

function renderAll() {
  const shouldFollow = isNearBottom() || messages.size === 0;
  log.querySelectorAll('.message-card').forEach((node) => {
    destroyMessageCardAnimation(node);
    node.remove();
  });

  const sorted = [...messages.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length) emptyState?.remove();
  for (const message of sorted) log.append(buildCard(message, false));
  if (shouldFollow) scrollBottom();
}

async function syncHistory() {
  try {
    const response = await fetch('/api/chat-history');
    const data = await response.json();
    let added = false;
    for (const message of data.messages ?? []) {
      if (!messages.has(message.id)) {
        messages.set(message.id, message);
        added = true;
      }
    }
    if (!historyLoaded || added) renderAll();
    historyLoaded = true;
  } catch (error) {
    console.error('Historique chat:', error);
    historyLoaded = true;
  }
}

function activeEventCards() {
  return log.querySelectorAll('.message-card.event');
}

function applyLiveAnimationSettings(settings) {
  eventAnimation = normalizeEventAnimation(settings);
  applyAnimationSettingsToCards(activeEventCards(), eventAnimation, {
    enabled: animationsEnabled,
    restartCurrent: false
  });
}

async function loadOverlaySettings() {
  eventAnimation = await loadEventAnimationSettings();
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
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  connectionState.textContent = 'Connexion…';
  connectionState.className = 'connection-state';

  socket.addEventListener('open', () => {
    connectionState.textContent = '● Flux connecté';
    connectionState.className = 'connection-state ok';
    void syncHistory();
  });

  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'hello' && handleServerVersion(data.payload?.version)) return;
    if (data.type === 'chat-message') {
      if (historyLoaded) appendMessage(data.payload);
      else messages.set(data.payload.id, data.payload);
    }
    if (data.type === 'overlay-settings') applyLiveAnimationSettings(data.payload);
  });

  socket.addEventListener('close', () => {
    connectionState.textContent = '● Reconnexion…';
    connectionState.className = 'connection-state off';
    setTimeout(connect, 1200);
  });
}

async function refreshCapabilities() {
  try {
    const data = await fetch('/api/status', { cache: 'no-store' }).then((r) => r.json());
    const twitchOk = Boolean(data.capabilities?.twitchSend);
    const youtubeOk = Boolean(data.capabilities?.youtubeSend);
    applyTargetCapabilities(twitchOk, youtubeOk);
  } catch (error) {
    console.error('Status send:', error);
  }
}

function applyTargetCapabilities(twitchOk, youtubeOk) {
  sendTwitch.disabled = !twitchOk;
  sendYouTube.disabled = !youtubeOk;
  sendBoth.disabled = !(twitchOk && youtubeOk);
  if (!twitchOk) sendTwitch.checked = false;
  if (!youtubeOk) sendYouTube.checked = false;

  if (!targetsInitialized) {
    const saved = localStorage.getItem('obs-chat-targets');
    if (saved) {
      try {
        const targets = JSON.parse(saved);
        sendTwitch.checked = twitchOk && targets.includes('twitch');
        sendYouTube.checked = youtubeOk && targets.includes('youtube');
      } catch {}
    }
    if (!sendTwitch.checked && !sendYouTube.checked) {
      if (twitchOk) sendTwitch.checked = true;
      else if (youtubeOk) sendYouTube.checked = true;
    }
    targetsInitialized = true;
  }
  syncBothCheckbox();
  sendNow.disabled = selectedTargets().length === 0;
}

function selectedTargets() {
  const targets = [];
  if (!sendTwitch.disabled && sendTwitch.checked) targets.push('twitch');
  if (!sendYouTube.disabled && sendYouTube.checked) targets.push('youtube');
  return targets;
}

function rememberTargets() {
  localStorage.setItem('obs-chat-targets', JSON.stringify(selectedTargets()));
  sendNow.disabled = selectedTargets().length === 0;
}

function syncBothCheckbox() {
  sendBoth.checked = !sendBoth.disabled && sendTwitch.checked && sendYouTube.checked;
}

function onIndividualTargetChanged() {
  syncBothCheckbox();
  rememberTargets();
}

function onBothTargetChanged() {
  if (sendBoth.disabled) return;
  sendTwitch.checked = sendBoth.checked;
  sendYouTube.checked = sendBoth.checked;
  rememberTargets();
}

async function sendChat(targets) {
  const message = input.value.trim();
  if (!message) return;
  try {
    const response = await fetch('/api/send-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets, message })
    });
    const data = await response.json();
    if (!response.ok && response.status !== 207) throw new Error(data.error || 'Erreur d\'envoi');

    const allOk = targets.every((target) => data.results?.[target]?.ok);
    const details = targets.map((target) => `${target === 'twitch' ? 'Twitch' : 'YouTube'}: ${data.results?.[target]?.ok ? 'OK' : (data.results?.[target]?.detail || 'échec')}`);
    sendStatus.textContent = details.join(' — ');
    sendStatus.className = allOk ? 'success' : 'error';
    if (allOk) input.value = '';
    updateCharCount();
    await refreshCapabilities();
  } catch (error) {
    sendStatus.textContent = error.message;
    sendStatus.className = 'error';
  }
}

function updateCharCount() {
  charCount.textContent = `${input.value.length}/500`;
}

newMessagesButton.addEventListener('click', scrollBottom);
sendTwitch.addEventListener('change', onIndividualTargetChanged);
sendYouTube.addEventListener('change', onIndividualTargetChanged);
sendBoth.addEventListener('change', onBothTargetChanged);
sendNow.addEventListener('click', () => {
  const targets = selectedTargets();
  if (targets.length) sendChat(targets);
});
input.addEventListener('input', updateCharCount);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const targets = selectedTargets();
    if (targets.length) sendChat(targets);
  }
});
log.addEventListener('scroll', () => {
  if (isNearBottom()) scrollBottom();
});

updateCharCount();
void refreshCapabilities();
setInterval(refreshCapabilities, 4000);
void loadOverlaySettings().finally(connect);
