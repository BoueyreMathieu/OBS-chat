(() => {
  const DPR = 1;
  const PATH_STEP = 2.4;
  const TRAIL_SPACING = 5.8;

  const spriteCache = new Map();
  const active = new Set();
  let rafId = 0;

  const styleIntensity = (style = '') => {
    if (style.endsWith('prime')) return .86;
    if (style.endsWith('tier3')) return 1.25;
    if (style.endsWith('tier2')) return 1.08;
    if (style.endsWith('tier1')) return .98;
    if (style.startsWith('community-gift-')) return 1.12;
    if (style.startsWith('superchat-tier')) {
      const tier = Number.parseInt(style.split('tier').pop() || '1', 10);
      return Math.min(1.35, .90 + Math.max(1, tier) * .06);
    }
    if (style.startsWith('supersticker-tier')) {
      const tier = Number.parseInt(style.split('tier').pop() || '1', 10);
      return Math.min(1.32, .88 + Math.max(1, tier) * .06);
    }
    if (style === 'reward') return 1.04;
    if (style === 'bits') return 1.08;
    if (style === 'raid') return 1.16;
    if (style.startsWith('membership')) return 1.02;
    return .98;
  };

  function parseRgb(root) {
    const value = getComputedStyle(root).getPropertyValue('--event-rgb').trim();
    const parts = value.split(',').map(v => Number.parseFloat(v.trim())).filter(Number.isFinite);
    return parts.length >= 3 ? parts.slice(0, 3) : [190, 132, 255];
  }

  function rgba(rgb, alpha) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
  }

  function spriteKey(rgb, intensity, glowScale) {
    return `${rgb.join('-')}:${intensity.toFixed(2)}:${glowScale.toFixed(2)}`;
  }

  function makeSprite(size, rgb, kind, intensity) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const mid = size / 2;
    const gradient = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);

    if (kind === 'head') {
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(.10, 'rgba(255,255,255,.98)');
      gradient.addColorStop(.24, rgba(rgb, .96));
      gradient.addColorStop(.52, rgba(rgb, .42));
      gradient.addColorStop(1, rgba(rgb, 0));
    } else {
      gradient.addColorStop(0, rgba(rgb, .82 * intensity));
      gradient.addColorStop(.28, rgba(rgb, .55 * intensity));
      gradient.addColorStop(.68, rgba(rgb, .16 * intensity));
      gradient.addColorStop(1, rgba(rgb, 0));
    }

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return canvas;
  }

  function getSprites(rgb, intensity, glowScale) {
    const key = spriteKey(rgb, intensity, glowScale);
    if (!spriteCache.has(key)) {
      spriteCache.set(key, {
        head: makeSprite(96, rgb, 'head', intensity * glowScale),
        tail: makeSprite(64, rgb, 'tail', intensity * glowScale)
      });
    }
    return spriteCache.get(key);
  }

  function addLine(points, x1, y1, x2, y2) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const count = Math.max(1, Math.ceil(len / PATH_STEP));
    for (let i = 0; i < count; i++) {
      const t = i / count;
      points.push({x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t});
    }
  }

  function addArc(points, cx, cy, radius, a0, a1) {
    const len = Math.abs(a1 - a0) * radius;
    const count = Math.max(2, Math.ceil(len / PATH_STEP));
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const a = a0 + (a1 - a0) * t;
      points.push({x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius});
    }
  }

  class GlowInstance {
    constructor(root, options = {}) {
      this.root = root;
      this.durationMs = numberOption(options.durationMs, 25000, 3000, 180000);
      this.fps = numberOption(options.fps, 60, 12, 120);
      this.frameMs = 1000 / this.fps;
      this.trailPx = numberOption(options.trailLength, 350, 80, 700);
      this.orbitMs = numberOption(options.orbitDuration, 4700, 1500, 12000);
      this.orbRadius = numberOption(options.orbSize, 7.5, 2, 16);
      this.glowScale = numberOption(options.glowIntensity, 1.10, .35, 2.5);
      // Zone transparente autour de la carte réservée au bloom.
      this.canvasPadding = numberOption(options.canvasPadding, 32, 16, 96);
      this.startedAt = performance.now();
      this.lastDraw = 0;
      this.rgb = parseRgb(root);
      this.intensity = styleIntensity(root.dataset.eventStyle || '');
      this.sprites = getSprites(this.rgb, this.intensity, this.glowScale);
      this.points = [];
      this.totalDistance = 0;
      this.effectiveTrailPx = this.trailPx;
      this.stopped = false;

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'event-glow-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      root.prepend(this.canvas);
      this.ctx = this.canvas.getContext('2d', {alpha: true, desynchronized: true});

      this.resize = this.resize.bind(this);
      this.resize();
      if ('ResizeObserver' in window) {
        this.observer = new ResizeObserver(this.resize);
        this.observer.observe(root);
      }

      if (options.animate === false) this.stop();
      else {
        active.add(this);
        ensureLoop();
      }
    }

    resize() {
      // offsetWidth/offsetHeight donnent la géométrie de layout de la carte commune.
      const w = Math.max(1, Math.round(this.root.offsetWidth));
      const h = Math.max(1, Math.round(this.root.offsetHeight));
      const pad = this.canvasPadding;
      const width = w + pad * 2;
      const height = h + pad * 2;

      this.canvas.style.left = `${-pad}px`;
      this.canvas.style.top = `${-pad}px`;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.canvas.width = Math.max(1, Math.round(width * DPR));
      this.canvas.height = Math.max(1, Math.round(height * DPR));
      this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

      const x = pad;
      const y = pad;
      const radius = Math.max(1, Math.min(
        parseFloat(getComputedStyle(this.root).borderRadius) || 11,
        h / 2 - 1,
        w / 2 - 1
      ));
      const points = [];

      addLine(points, x + radius, y, x + w - radius, y);
      addArc(points, x + w - radius, y + radius, radius, -Math.PI / 2, 0);
      addLine(points, x + w, y + radius, x + w, y + h - radius);
      addArc(points, x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
      addLine(points, x + w - radius, y + h, x + radius, y + h);
      addArc(points, x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
      addLine(points, x, y + h - radius, x, y + radius);
      addArc(points, x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);

      this.points = points;
      this.totalDistance = points.length * PATH_STEP;
      this.effectiveTrailPx = this.trailPx;
      this.clear();
    }

    pointAtDistance(distance) {
      const count = this.points.length;
      if (!count) return {x: 0, y: 0};
      const index = ((distance / PATH_STEP) % count + count) % count;
      const i = Math.floor(index);
      const f = index - i;
      const a = this.points[i];
      const b = this.points[(i + 1) % count];
      return {x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f};
    }

    drawComet(headDistance) {
      const count = Math.ceil(this.effectiveTrailPx / TRAIL_SPACING);
      const ctx = this.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      for (let i = count; i >= 1; i--) {
        const u = i / count;
        const fade = Math.pow(1 - u, 2.05);
        const p = this.pointAtDistance(headDistance - i * TRAIL_SPACING);
        const alpha = .72 * fade * this.intensity;
        const size = (4 + 22 * Math.pow(fade, .75)) * this.intensity * this.glowScale;
        ctx.globalAlpha = Math.min(.94, alpha);
        ctx.drawImage(this.sprites.tail, p.x - size / 2, p.y - size / 2, size, size);
      }

      const head = this.pointAtDistance(headDistance);
      ctx.globalAlpha = 1;
      const orb = this.orbRadius * this.intensity;
      const bloom = orb * (5.0 + .5 * this.glowScale);
      ctx.globalAlpha = .92;
      ctx.drawImage(this.sprites.head, head.x - bloom / 2, head.y - bloom / 2, bloom, bloom);
      ctx.restore();
    }

    draw(now) {
      if (this.stopped) return false;
      const elapsed = now - this.startedAt;
      if (elapsed >= this.durationMs) {
        this.stop();
        return false;
      }
      if (this.lastDraw && now - this.lastDraw < this.frameMs) return true;
      this.lastDraw = now;
      this.clear();
      const progress = (elapsed % this.orbitMs) / this.orbitMs;
      const headA = progress * this.totalDistance;
      const headB = (progress + .5) * this.totalDistance;
      this.drawComet(headA);
      this.drawComet(headB);
      return true;
    }

    clear() {
      if (!this.ctx) return;
      this.ctx.clearRect(0, 0, this.canvas.width / DPR, this.canvas.height / DPR);
    }

    stop() {
      if (this.stopped) return;
      this.stopped = true;
      active.delete(this);
      this.clear();
      this.root.classList.add('event-glow-static');
    }

    restart(options = {}) {
      this.durationMs = numberOption(options.durationMs, this.durationMs, 3000, 180000);
      this.fps = numberOption(options.fps, this.fps, 12, 120);
      this.frameMs = 1000 / this.fps;
      this.trailPx = numberOption(options.trailLength, this.trailPx, 80, 700);
      this.orbitMs = numberOption(options.orbitDuration, this.orbitMs, 1500, 12000);
      this.orbRadius = numberOption(options.orbSize, this.orbRadius, 2, 16);
      this.glowScale = numberOption(options.glowIntensity, this.glowScale, .35, 2.5);
      this.canvasPadding = numberOption(options.canvasPadding, this.canvasPadding, 16, 96);
      this.resize();
      this.sprites = getSprites(this.rgb, this.intensity, this.glowScale);
      this.startedAt = performance.now();
      this.lastDraw = 0;
      this.stopped = false;
      this.root.classList.remove('event-glow-static');
      active.add(this);
      ensureLoop();
    }

    destroy() {
      active.delete(this);
      this.stopped = true;
      if (this.observer) this.observer.disconnect();
      this.clear();
      this.canvas.remove();
    }
  }

  function numberOption(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function ensureLoop() {
    if (!rafId && active.size && !document.hidden) rafId = requestAnimationFrame(loop);
  }

  function loop(now) {
    rafId = 0;
    if (document.hidden || !active.size) return;
    for (const instance of [...active]) instance.draw(now);
    if (active.size) rafId = requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } else {
      const now = performance.now();
      for (const instance of [...active]) instance.draw(now);
      ensureLoop();
    }
  });

  window.EventGlowLite = {
    attach(root, options = {}) {
      if (root.__eventGlowLite) root.__eventGlowLite.destroy();
      if (options.animate === false) {
        root.classList.add('event-glow-static');
        delete root.__eventGlowLite;
        return null;
      }
      const instance = new GlowInstance(root, options);
      root.__eventGlowLite = instance;
      return instance;
    },
    restart(root, options = {}) {
      const current = root?.__eventGlowLite;
      if (current) current.restart(options);
      else if (root) this.attach(root, options);
    },
    destroy(root) {
      root?.__eventGlowLite?.destroy();
      if (root) delete root.__eventGlowLite;
    }
  };
})();
