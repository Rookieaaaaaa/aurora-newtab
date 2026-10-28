/**
 * background.js — 背景引擎
 * 支持五种类型：bing（必应每日壁纸）/ wallhaven（在线壁纸库）/ static（图片）/ video（视频）/ gradient（动态渐变 + 粒子）
 * 特性：双层交叉淡入（400ms）、模糊与暗化实时生效、失败自动降级到渐变、页面隐藏时暂停。
 */

import { BING_API, GRADIENTS, STORAGE_KEYS } from './defaults.js';
import { getMedia, getRaw, setRaw } from './storage.js';
import {
  fetchWallhavenBlob,
  loadBundledWallhaven,
  loadLastWallhaven,
  persistWallhavenBlob,
  resolveWallhaven,
} from './wallhaven.js';
import { resolveWeBackground } from './weworkshop.js';

const FADE_MS = 400;
const IMAGE_TIMEOUT = 12000;
const VIDEO_TIMEOUT = 16000;
const BING_TIMEOUT = 8000;
const MAX_PARTICLES = 60;

/** 本地日期 key（用于必应壁纸当日缓存）。 */
function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** hex → rgba 字符串。 */
function hexToRgba(hex, alpha) {
  const value = String(hex || '').replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value.padEnd(6, '0').slice(0, 6);
  const num = Number.parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 加载图片（带超时）。 */
function loadImage(url, timeout = IMAGE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('图片地址为空'));
      return;
    }
    const img = new Image();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      img.src = '';
      reject(new Error('图片加载超时'));
    }, timeout);

    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!img.naturalWidth) {
        reject(new Error('图片内容为空'));
        return;
      }
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('图片加载失败'));
    };

    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.alt = '';
    img.src = url;
  });
}

/** 创建并加载视频元素（带超时）。 */
function loadVideo(url, timeout = VIDEO_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('视频地址为空'));
      return;
    }
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('webkit-playsinline', '');
    video.disablePictureInPicture = true;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('视频加载超时'));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onOk);
      video.removeEventListener('error', onErr);
    };

    const onOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          /* 自动播放被拦截时保持首帧，不影响展示 */
        });
      }
      resolve(video);
    };

    const onErr = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('视频加载失败'));
    };

    video.addEventListener('loadeddata', onOk);
    video.addEventListener('error', onErr);
    video.src = url;
  });
}

/**
 * 只加载视频元数据（不缓冲正片），用于分辨率自适应判断。
 * 返回的 video 元素可直接继续用作背景（后续 autoplay 会接着缓冲）。
 */
function probeVideoMeta(url, timeout = VIDEO_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('视频地址为空'));
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.disablePictureInPicture = true;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('视频加载超时'));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onOk);
      video.removeEventListener('error', onErr);
    };

    const onOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(video);
    };

    const onErr = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('视频加载失败'));
    };

    video.addEventListener('loadedmetadata', onOk);
    video.addEventListener('error', onErr);
    video.src = url;
  });
}

/**
 * 创建动态渐变图层（canvas）。
 * @param {string} themeKey
 * @param {boolean} withParticles
 * @returns {{el:HTMLCanvasElement, cleanup:Function, pause:Function, resume:Function}}
 */
function createGradientLayer(themeKey, withParticles) {
  const theme = GRADIENTS[themeKey] || GRADIENTS.forest;
  const palette = theme.colors;
  const glowColor = theme.glow || palette[3];
  const beamColor = theme.beam || palette[3];
  const mistColor = palette[3];

  const canvas = document.createElement('canvas');
  canvas.className = 'bg-media';
  const ctx = canvas.getContext('2d');

  // 静态层（底色层次 + 光晕 + 斜向光束 + 噪点）只画一次，逐帧直接贴图，省算力
  const backdrop = document.createElement('canvas');
  const backdropCtx = backdrop.getContext('2d');
  let noiseTile = null;

  const state = {
    width: 0,
    height: 0,
    dpr: 1,
    raf: 0,
    last: 0,
    start: performance.now(),
    running: false,
    reduced: false,
    blobs: [],
    particles: [],
  };

  try {
    state.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    state.reduced = false;
  }

  /** 生成 96×96 的透明噪点瓦片（不引任何外部图片）。 */
  const buildNoise = () => {
    const size = 96;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const tileCtx = tile.getContext('2d');
    if (!tileCtx) return null;
    const image = tileCtx.createImageData(size, size);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const value = Math.random() < 0.5 ? 255 : 0;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = Math.random() * 22;
    }
    tileCtx.putImageData(image, 0, 0);
    return tile;
  };

  // 流动光斑：亮色与中间色交替，营造薄雾层次
  for (let i = 0; i < 5; i += 1) {
    state.blobs.push({
      color: i % 2 === 0 ? palette[3] : palette[2],
      ox: 0.16 + ((i * 0.21) % 0.7),
      oy: 0.22 + ((i * 0.31) % 0.56),
      ax: 0.08 + (i % 3) * 0.03,
      ay: 0.06 + (i % 2) * 0.04,
      speed: 0.00008 + i * 0.000022,
      phase: i * 1.9,
      radius: 0.30 + (i % 3) * 0.1,
      alpha: 0.3 + (i % 3) * 0.06,
    });
  }

  if (withParticles) {
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      state.particles.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.6 + Math.random() * 1.5,
        vy: 0.000035 + Math.random() * 0.00007,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.18 + Math.random() * 0.34,
      });
    }
  }

  /** 绘制静态背景层。 */
  const renderBackdrop = () => {
    if (!backdropCtx) return;
    const w = state.width;
    const h = state.height;
    backdrop.width = canvas.width;
    backdrop.height = canvas.height;
    backdropCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    backdropCtx.clearRect(0, 0, w, h);

    // 1) 垂直层次：顶部深 → 上部亮 → 中部薄雾 → 底部深
    const vertical = backdropCtx.createLinearGradient(0, 0, 0, h);
    vertical.addColorStop(0, palette[0]);
    vertical.addColorStop(0.26, palette[1]);
    vertical.addColorStop(0.52, palette[2]);
    vertical.addColorStop(0.74, palette[1]);
    vertical.addColorStop(1, palette[4] || palette[0]);
    backdropCtx.fillStyle = vertical;
    backdropCtx.fillRect(0, 0, w, h);

    // 2) 上部暖光晕（晨雾高光，位置略偏左更自然）
    const glowCx = w * 0.44;
    const glowCy = -h * 0.04;
    const glow = backdropCtx.createRadialGradient(
      glowCx,
      glowCy,
      0,
      glowCx,
      glowCy,
      Math.max(w, h) * 0.8,
    );
    glow.addColorStop(0, hexToRgba(glowColor, 0.5));
    glow.addColorStop(0.35, hexToRgba(glowColor, 0.16));
    glow.addColorStop(1, hexToRgba(glowColor, 0));
    backdropCtx.fillStyle = glow;
    backdropCtx.fillRect(0, 0, w, h);

    // 3) 中部横向雾带（压扁的椭圆，制造纵深）
    backdropCtx.save();
    backdropCtx.translate(w * 0.5, h * 0.56);
    backdropCtx.scale(1, 0.32);
    const mist = backdropCtx.createRadialGradient(0, 0, 0, 0, 0, w * 0.72);
    mist.addColorStop(0, hexToRgba(mistColor, 0.18));
    mist.addColorStop(0.55, hexToRgba(mistColor, 0.06));
    mist.addColorStop(1, hexToRgba(mistColor, 0));
    backdropCtx.fillStyle = mist;
    backdropCtx.fillRect(-w, -h * 3, w * 2, h * 6);
    backdropCtx.restore();

    // 4) 斜向光束：细、低对比、在 74% 高度处淡出，避免"条纹感"
    const beams = [
      { x: 0.3, half: 0.03, skew: 0.2, alpha: 0.13 },
      { x: 0.47, half: 0.048, skew: 0.16, alpha: 0.085 },
      { x: 0.66, half: 0.024, skew: 0.24, alpha: 0.11 },
    ];
    backdropCtx.save();
    backdropCtx.globalCompositeOperation = 'lighter';
    beams.forEach((beam) => {
      const x = beam.x * w;
      const halfWidth = beam.half * w;
      const shift = beam.skew * w;
      const fadeTo = h * 0.74;
      const gradient = backdropCtx.createLinearGradient(x, 0, x + shift * 0.5, fadeTo);
      gradient.addColorStop(0, hexToRgba(beamColor, beam.alpha * 1.25));
      gradient.addColorStop(0.45, hexToRgba(beamColor, beam.alpha * 0.5));
      gradient.addColorStop(1, hexToRgba(beamColor, 0));
      backdropCtx.fillStyle = gradient;
      backdropCtx.beginPath();
      backdropCtx.moveTo(x - halfWidth, -2);
      backdropCtx.lineTo(x + halfWidth, -2);
      backdropCtx.lineTo(x + halfWidth + shift, fadeTo);
      backdropCtx.lineTo(x - halfWidth + shift, fadeTo);
      backdropCtx.closePath();
      backdropCtx.fill();
    });
    backdropCtx.restore();

    // 4) 极轻噪点，避免大面积色带
    if (!noiseTile) noiseTile = buildNoise();
    if (noiseTile) {
      const pattern = backdropCtx.createPattern(noiseTile, 'repeat');
      if (pattern) {
        backdropCtx.save();
        backdropCtx.globalAlpha = 0.05;
        backdropCtx.globalCompositeOperation = 'overlay';
        backdropCtx.fillStyle = pattern;
        backdropCtx.fillRect(0, 0, w, h);
        backdropCtx.restore();
      }
    }
  };

  const draw = (now) => {
    if (!ctx) return;
    const w = state.width;
    const h = state.height;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    if (backdrop.width) {
      ctx.drawImage(backdrop, 0, 0, w, h);
    } else {
      ctx.fillStyle = palette[1];
      ctx.fillRect(0, 0, w, h);
    }

    // 流动光斑
    const elapsed = now - state.start;
    ctx.globalCompositeOperation = 'screen';
    state.blobs.forEach((blob) => {
      const t = elapsed * blob.speed;
      const cx = (blob.ox + Math.sin(t + blob.phase) * blob.ax) * w;
      const cy = (blob.oy + Math.cos(t * 0.85 + blob.phase) * blob.ay) * h;
      const radius = blob.radius * Math.max(w, h);
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, hexToRgba(blob.color, blob.alpha));
      gradient.addColorStop(0.55, hexToRgba(blob.color, blob.alpha * 0.34));
      gradient.addColorStop(1, hexToRgba(blob.color, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    });

    // 细粒子
    ctx.globalCompositeOperation = 'source-over';
    state.particles.forEach((particle) => {
      const sway = Math.sin(elapsed * 0.0004 + particle.phase) * 0.01;
      const x = (particle.x + sway) * w;
      const y = particle.y * h;
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 255, 255, ${particle.alpha})`;
      ctx.arc(x, y, particle.r, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const stepParticles = () => {
    state.particles.forEach((particle) => {
      particle.y -= particle.vy * 1000;
      if (particle.y < -0.02) {
        particle.y = 1.02;
        particle.x = Math.random();
      }
    });
  };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    state.width = width;
    state.height = height;
    state.dpr = dpr;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    renderBackdrop();
    draw(performance.now());
  };

  const frame = (now) => {
    state.raf = window.requestAnimationFrame(frame);
    if (now - state.last < 33) return; // 上限约 30fps
    state.last = now;
    stepParticles();
    draw(now);
  };

  const resume = () => {
    if (state.running || state.reduced) return;
    state.running = true;
    state.last = 0;
    state.raf = window.requestAnimationFrame(frame);
  };

  const pause = () => {
    state.running = false;
    if (state.raf) {
      window.cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
  };

  const onResize = () => resize();

  window.addEventListener('resize', onResize, { passive: true });
  resize();

  if (!state.reduced) resume();
  else draw(performance.now());

  return {
    el: canvas,
    cleanup: () => {
      pause();
      window.removeEventListener('resize', onResize);
    },
    pause,
    resume,
  };
}

/**
 * 背景控制器。
 */
export class BackgroundController {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root 背景容器（承载 --bg-blur / --bg-dim 变量）
   * @param {HTMLElement[]} options.layers 两个背景层
   * @param {Function} [options.onToast] (message, type) => void
   */
  constructor({ root, layers, onToast }) {
    this.root = root;
    this.layers = layers;
    this.onToast = typeof onToast === 'function' ? onToast : () => {};
    this.activeIndex = 0;
    this.signature = '';
    this.token = 0;
    this.current = null;
    this.settings = null;
    this.objectUrls = new Set();
    this.onVisibility = this.onVisibility.bind(this);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** 首次应用。 */
  init(settings) {
    this.apply(settings, true);
  }

  /** 设置变化时调用（内部会做差分，画质参数只更新叠加层）。 */
  update(settings) {
    this.apply(settings, false);
  }

  /** 计算背景内容签名（不含 blur / dim）。 */
  static signatureOf(settings) {
    const bg = (settings && settings.background) || {};
    return JSON.stringify({
      type: bg.type,
      imageUrl: bg.imageUrl,
      imageMediaId: bg.imageMediaId,
      videoUrl: bg.videoUrl,
      videoMediaId: bg.videoMediaId,
      gradient: bg.gradient,
      particles: bg.particles,
      bingMkt: bg.bingMkt,
      wallhavenMode: bg.wallhavenMode,
      wallhavenQuery: bg.wallhavenQuery,
      wallhavenCategories: bg.wallhavenCategories,
      weMode: bg.weMode,
      weItemId: bg.weItemId,
      weImage: bg.weImage,
      weVideo: bg.weVideo,
      weFit: bg.weFit,
    });
  }

  /** 应用设置。 */
  async apply(settings, first) {
    this.settings = settings;
    const bg = settings.background;
    this.root.style.setProperty('--bg-blur', `${Number(bg.blur) || 0}px`);
    this.root.style.setProperty('--bg-dim', String(Math.min(0.8, Math.max(0, Number(bg.dim) || 0))));

    const signature = BackgroundController.signatureOf(settings);
    if (signature === this.signature && !first) return;
    this.signature = signature;

    const token = ++this.token;
    const targetIndex = 1 - this.activeIndex;
    const target = this.layers[targetIndex];
    if (!target) return;
    this.clearLayer(target);

    let layer = null;
    try {
      layer = await this.buildLayer(bg);
    } catch (err) {
      console.warn('[background] 当前背景加载失败，已回退到动态渐变：', err);
      const reason = err && err.message ? err.message : '未知原因';
      this.onToast(`${reason}，已回退到默认背景`, 'error');
      layer = createGradientLayer('forest', true);
    }

    if (token !== this.token) {
      // 已有更新的请求，丢弃本次结果
      if (layer && typeof layer.cleanup === 'function') layer.cleanup();
      return;
    }

    // 把清理函数挂到元素上，便于 clearLayer 统一回收
    if (layer && layer.el && typeof layer.cleanup === 'function') {
      layer.el.__auroraCleanup = layer.cleanup;
    }
    target.appendChild(layer.el);
    void target.offsetHeight;
    target.dataset.active = 'true';
    const previous = this.layers[this.activeIndex];
    if (previous) previous.dataset.active = 'false';
    this.activeIndex = targetIndex;
    this.current = layer;

    const staleLayer = previous;
    window.setTimeout(() => {
      if (token !== this.token) return;
      this.clearLayer(staleLayer);
    }, FADE_MS + 80);
  }

  /** 构造单层内容。 */
  async buildLayer(bg) {
    const type = bg.type;

    if (type === 'gradient') {
      return createGradientLayer(bg.gradient, bg.particles !== false);
    }

    if (type === 'wallhaven') {
      // 在线壁纸库，四级回退：在线（直连/中转）→ 本地上一张 → 内置精选包 → 抛错（外层回退渐变）
      const relay = bg.wallhavenRelay !== false;
      const relayUrl = String(bg.wallhavenRelayUrl || '').trim();
      let url = '';
      let blob = null;
      let lastError = null;
      try {
        const record = await resolveWallhaven(bg);
        url = record.url;
        blob = await fetchWallhavenBlob(url, { relay, relayUrl });
        // 展示不等持久化；随机模式下也只在新图时真正写库
        persistWallhavenBlob(url, blob).catch(() => {});
      } catch (err) {
        lastError = err;
      }
      if (!blob) {
        const last = await loadLastWallhaven().catch(() => null);
        if (last) {
          blob = last.blob;
          url = last.url || 'wallhaven-last';
        }
      }
      if (blob) {
        const objectUrl = URL.createObjectURL(blob);
        this.objectUrls.add(objectUrl);
        const img = await loadImage(objectUrl);
        img.className = 'bg-media';
        img.dataset.objectUrl = objectUrl;
        return {
          el: img,
          cleanup: () => this.revokeUrl(objectUrl),
          pause: () => {},
          resume: () => {},
        };
      }
      // 本地内置精选包：零网络，理论不会失败
      try {
        const bundledUrl = loadBundledWallhaven();
        const img = await loadImage(bundledUrl);
        img.className = 'bg-media';
        return { el: img, cleanup: () => {}, pause: () => {}, resume: () => {} };
      } catch (err) {
        throw lastError || err;
      }
    }

    if (type === 'we') {
      // Wallpaper Engine 创意工坊：分辨率自适应——
      // 工坊预览视频多为 720p webm，铺满高分屏会发糊；视频元数据不够屏幕宽度时
      // 改用全尺寸截图，截图加载失败再回视频，两者都失败才报错
      const record = await resolveWeBackground(bg);
      // 显示方式：cover 填满裁切（默认，整屏无黑边）；contain 完整显示（等比缩放留边）
      const containFit = bg.weFit === 'contain';
      const applyFit = (el) => {
        el.style.objectFit = containFit ? 'contain' : '';
        el.style.transform = containFit ? 'none' : '';
      };

      const makeVideoLayer = (video) => {
        video.className = 'bg-media';
        video.dataset.objectUrl = '';
        video.preload = 'auto';
        applyFit(video);
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
        return {
          el: video,
          cleanup: () => {
            try {
              video.pause();
            } catch (err) {
              /* ignore */
            }
            video.removeAttribute('src');
            try {
              video.load();
            } catch (err) {
              /* ignore */
            }
          },
          pause: () => {
            try {
              video.pause();
            } catch (err) {
              /* ignore */
            }
          },
          resume: () => {
            const promise = video.play();
            if (promise && typeof promise.catch === 'function') promise.catch(() => {});
          },
        };
      };

      const makeImageLayer = (img) => {
        img.className = 'bg-media';
        img.dataset.objectUrl = '';
        applyFit(img);
        return { el: img, cleanup: () => {}, pause: () => {}, resume: () => {} };
      };

      if (record.video) {
        let video = null;
        try {
          video = await probeVideoMeta(record.video);
        } catch (err) {
          console.warn('[background] 工坊视频预加载失败，将使用截图：', err);
        }
        if (video) {
          // 目标宽度：视口 CSS 宽 × DPR（上限 2，高分屏按 2 倍采样即可观感清晰），下限 1280
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const needWidth = Math.max(1280, Math.round((window.innerWidth || 1280) * dpr));
          const videoWidth = video.videoWidth || 0;
          const videoSharp = !record.image || videoWidth >= needWidth || videoWidth >= 1920;
          if (videoSharp) return makeVideoLayer(video);
          try {
            const img = await loadImage(record.image);
            return makeImageLayer(img);
          } catch (err) {
            console.warn('[background] 工坊截图加载失败，回退视频：', err);
            return makeVideoLayer(video);
          }
        }
      }

      if (!record.image) throw new Error('工坊壁纸没有可用的预览资源');
      const img = await loadImage(record.image);
      return makeImageLayer(img);
    }

    if (type === 'static') {
      const url = await this.resolveStaticUrl(bg);
      const img = await loadImage(url);
      img.className = 'bg-media';
      img.dataset.objectUrl = url.startsWith('blob:') ? url : '';
      return {
        el: img,
        cleanup: () => {
          if (url.startsWith('blob:')) this.revokeUrl(url);
        },
        pause: () => {},
        resume: () => {},
      };
    }

    if (type === 'video') {
      const url = await this.resolveVideoUrl(bg);
      const video = await loadVideo(url);
      video.className = 'bg-media';
      video.dataset.objectUrl = url.startsWith('blob:') ? url : '';
      return {
        el: video,
        cleanup: () => {
          try {
            video.pause();
          } catch (err) {
            /* ignore */
          }
          video.removeAttribute('src');
          try {
            video.load();
          } catch (err) {
            /* ignore */
          }
          if (url.startsWith('blob:')) this.revokeUrl(url);
        },
        pause: () => {
          try {
            video.pause();
          } catch (err) {
            /* ignore */
          }
        },
        resume: () => {
          const promise = video.play();
          if (promise && typeof promise.catch === 'function') promise.catch(() => {});
        },
      };
    }

    // 默认 bing
    const record = await this.resolveBing(bg.bingMkt || 'zh-CN');
    const candidates = [];
    if (record.urlBase) {
      candidates.push(`${record.urlBase}_UHD.jpg`, `${record.urlBase}_1920x1080.jpg`);
    }
    if (record.url) candidates.push(record.url);

    let lastError = new Error('必应壁纸加载失败');
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const img = await loadImage(candidates[i]);
        img.className = 'bg-media';
        return { el: img, cleanup: () => {}, pause: () => {}, resume: () => {} };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  /** 解析静态图片地址（网络 URL 或 IndexedDB 媒体）。 */
  async resolveStaticUrl(bg) {
    if (bg.imageMediaId) {
      const record = await getMedia(bg.imageMediaId).catch(() => null);
      if (record && record.blob) {
        const url = URL.createObjectURL(record.blob);
        this.objectUrls.add(url);
        return url;
      }
      console.warn('[background] 本地图片读取失败，尝试回退网络地址');
    }
    if (bg.imageUrl) return bg.imageUrl;
    throw new Error('未设置背景图片');
  }

  /** 解析视频地址。 */
  async resolveVideoUrl(bg) {
    if (bg.videoMediaId) {
      const record = await getMedia(bg.videoMediaId).catch(() => null);
      if (record && record.blob) {
        const url = URL.createObjectURL(record.blob);
        this.objectUrls.add(url);
        return url;
      }
      console.warn('[background] 本地视频读取失败，尝试回退网络地址');
    }
    if (bg.videoUrl) return bg.videoUrl;
    throw new Error('未设置视频地址');
  }

  /** 解析必应每日壁纸（当天缓存）。 */
  async resolveBing(market) {
    const today = localDateKey();
    const cache = await getRaw(STORAGE_KEYS.bingCache).catch(() => null);
    if (cache && cache.date === today && cache.urlBase && cache.mkt === market) {
      return cache;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BING_TIMEOUT);
    try {
      const response = await fetch(`${BING_API}${encodeURIComponent(market)}`, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`必应壁纸接口返回 HTTP ${response.status}`);
      const data = await response.json();
      const item =
        data && Array.isArray(data.images) && data.images.length ? data.images[0] : null;
      if (!item || !item.urlbase) throw new Error('必应壁纸返回数据异常');

      const record = {
        date: today,
        mkt: market,
        urlBase: `https://www.bing.com${item.urlbase}`,
        url: item.url ? new URL(item.url, 'https://www.bing.com').toString() : '',
        copyright: item.copyright || '',
      };
      await setRaw(STORAGE_KEYS.bingCache, record).catch(() => false);
      return record;
    } catch (err) {
      if (cache && cache.urlBase) {
        console.warn('[background] 必应接口失败，使用缓存壁纸', err);
        return cache;
      }
      throw new Error('必应壁纸获取失败');
    } finally {
      clearTimeout(timer);
    }
  }

  /** 释放 objectURL。 */
  revokeUrl(url) {
    if (!url) return;
    try {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(url);
    } catch (err) {
      /* ignore */
    }
  }

  /** 清空某一层（含资源回收）。 */
  clearLayer(layer) {
    if (!layer) return;
    const nodes = Array.prototype.slice.call(layer.children || []);
    nodes.forEach((node) => {
      if (node.__auroraCleanup) {
        try {
          node.__auroraCleanup();
        } catch (err) {
          /* ignore */
        }
      }
    });
    layer.textContent = '';
  }

  onVisibility() {
    if (!this.current) return;
    if (document.hidden) {
      if (typeof this.current.pause === 'function') this.current.pause();
    } else if (typeof this.current.resume === 'function') {
      this.current.resume();
    }
  }

  /** 卸载。 */
  destroy() {
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.current && typeof this.current.cleanup === 'function') this.current.cleanup();
    this.layers.forEach((layer) => this.clearLayer(layer));
    this.objectUrls.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch (err) {
        /* ignore */
      }
    });
    this.objectUrls.clear();
  }
}
