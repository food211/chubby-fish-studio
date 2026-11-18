/**
 * Build `client.js` for the DSH bundle from the Mixbox Palette sources.
 *
 * The app is a set of global scripts (see app.html) that assume a full page,
 * a global `document`, and the desktop host bridge. This script folds the KM engine and
 * the UI into one DSH client module:
 *   - drops PS-only modules (ps-bridge, onboarding, updater, announcer, service
 *     worker bootstrap) and the Mixbox engine, keeping the custom KM renderer,
 *   - turns the body markup into a template mounted inside a shadow root,
 *   - injects `document`, `window`, and `localStorage` shims at boot so the app
 *     cannot touch host DOM, host keyboard shortcuts, or host storage,
 *   - appends a small surface the DSH runtime drives (snapshot, state, strokes).
 *
 * Usage: node build/build-client.mjs [--src <checkout>]
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const argv = process.argv.slice(2)
const srcFlag = argv.indexOf('--src')
const SRC = srcFlag === -1
  ? (process.env.MPX_SRC || 'D:\\image\\2022\\同人\\mixbox-palette')
  : argv[srcFlag + 1]

const read = (rel) => readFileSync(join(SRC, rel), 'utf8')
const dataUri = (rel, mime = 'image/svg+xml') =>
  `data:${mime};base64,${readFileSync(join(SRC, rel)).toString('base64')}`

const problems = []
function replaceOnce(text, find, replacement, label) {
  // Sources may arrive with CRLF endings; match either, and keep the file's own
  // endings in the inserted text, so a patch never depends on how git delivered it.
  let needle = find
  let index = text.indexOf(needle)
  if (index === -1 && find.includes('\n')) {
    needle = find.replace(/\n/g, '\r\n')
    index = text.indexOf(needle)
  }
  if (index === -1) { problems.push(`missing patch target: ${label}`); return text }
  if (text.indexOf(needle, index + needle.length) !== -1) problems.push(`ambiguous patch target: ${label}`)
  const insert = needle.includes('\r\n') ? replacement.replace(/\n/g, '\r\n') : replacement
  return text.slice(0, index) + insert + text.slice(index + needle.length)
}

// ------------------------------------------------------------------ app shell

const appHtml = read('app.html')

function extractBodyMarkup(html) {
  const bodyOpen = html.indexOf('<body')
  if (bodyOpen === -1) throw new Error('app.html has no <body>')
  const bodyStart = html.indexOf('>', bodyOpen) + 1
  const marker = html.indexOf('<!-- 脚本加载 -->')
  if (marker === -1) throw new Error('app.html script marker not found')
  return html.slice(bodyStart, marker)
}

function extractHeadStyle(html) {
  const open = html.lastIndexOf('<style>')
  const close = html.indexOf('</style>', open)
  if (open === -1 || close === -1) throw new Error('app.html head style not found')
  return html.slice(open + '<style>'.length, close)
}

let markup = extractBodyMarkup(appHtml)
const iconRefs = [...markup.matchAll(/src="(icons\/[^"]+\.svg)"/g)].map((match) => match[1])
for (const iconRef of new Set(iconRefs)) {
  markup = markup.split(`src="${iconRef}"`).join(`src="${dataUri(iconRef)}"`)
}
// The GitHub/Discord capsules call a helper that is not a global in the bundle.
markup = markup.replace(/<a [^>]*onclick="openExternalURL\([^"]*"[^>]*>[\s\S]*?<\/a>/g, '')
markup = markup.replace(/\s*on\w+="[^"]*"/g, '')
if (/src="icons\//.test(markup)) problems.push('markup still references a relative icon path')

// ------------------------------------------------------------------ vendor js

const BRIDGE_STUB = `
// ===== DSH bundle: stand-in for the upstream host bridge (no host here) =====
const CANVAS_BG = { r: 1, g: 1, b: 1 };

function showAlert(message) {
    const modal = document.getElementById('alertModal');
    const text = document.getElementById('alertModalText');
    const okButton = document.getElementById('alertModalOkBtn');
    if (!modal || !text || !okButton) { console.warn('[mpx]', message); return; }
    text.textContent = message;
    modal.classList.add('active');
    okButton.onclick = () => modal.classList.remove('active');
}

function isInWebView() { return false; }
function getHostVersion() { return null; }
function compareVersions() { return 0; }
function checkHostCompatibility() { return true; }
function sendColorToPS() {}
function openExternalURL(url) {
    try { window.open(url, '_blank', 'noopener'); } catch (_error) {}
}

// app.html's bootstrap owned this probe; createPainter() still calls it.
function isWebGLSupported() {
    try {
        const probe = document.createElement('canvas');
        return !!(window.WebGLRenderingContext
            && (probe.getContext('webgl') || probe.getContext('experimental-webgl')));
    } catch (_error) {
        return false;
    }
}
`

// Loading order mirrors app.html's tiered loader, with PS-only rows removed.
const JS_ORDER = [
  'js/i18n-translations.js',
  'js/i18n.js',
  'js/params.js',
  'js/device-profile.js',
  'js/frame-scheduler.js',
  'js/base-painter.js',
  'js/brush-manager.js',
  'js/palette-storage.js',
  '@bridge',
  'js/palette-presets.js',
  'js/zoom.js',
  'js/heatmap.js',
  'js/wetpaper.js',
  'js/drip.js',
  'js/km-painter.js',
  'js/app.js',
]

// The instructions list is rendered by the client runtime (runtime.js), not through
// the app's i18n dictionary: the upstream lines tie it to a desktop host, and the
// dictionary pass does not reliably reach those nodes.

let vendor = JS_ORDER.map((rel) => {
  const body = rel === '@bridge' ? BRIDGE_STUB : read(rel)
  const tail = rel === 'js/i18n.js'
    ? '\nI18N.init(); // app.html used to call this before loading the rest\n'
    : ''
  return `\n// ---------------------------------------------------------------- ${rel === '@bridge' ? 'stub: js/ps-bridge.js' : rel}\n${body}${tail}`
}).join('\n')

vendor = replaceOnce(
  vendor,
  "a.download = 'mixbox-palette.png';",
  "a.download = 'CFS-' + Date.now() + '.png';",
  'studio PNG download name',
)
vendor = replaceOnce(
  vendor,
  'function _bindDebugShortcuts(painter) {',
  'function _bindDebugShortcuts(painter) {\n    return; // DSH: window.help/h getters are host pollution\n',
  'disable debug shortcuts',
)
vendor = replaceOnce(
  vendor,
  "const workerURL = base ? new URL('./history-worker.js', base).href : 'js/history-worker.js';",
  "const workerURL = globalThis.__MPX_WORKER_URL || (base ? new URL('./history-worker.js', base).href : 'js/history-worker.js');",
  'history worker url',
)
vendor = replaceOnce(
  vendor,
  "const LUT_URL = 'assets/km-lut.png';",
  "const LUT_URL = globalThis.__MPX_LUT_URL || 'assets/km-lut.png';",
  'km lut url',
)
vendor = replaceOnce(
  vendor,
  'Object.defineProperties(globalThis, Object.getOwnPropertyDescriptors(_brushSizeAccessor));',
  'try { Object.defineProperties(globalThis, Object.getOwnPropertyDescriptors(_brushSizeAccessor)); } catch (_mpxError) {}',
  'brush size accessor install',
)
vendor = replaceOnce(
  vendor,
  "const savedEngine = localStorage.getItem('mixbox_engine') || 'km';",
  "const savedEngine = 'km'; // DSH bundle ships the KM engine only",
  'force km engine',
)
// Drip run-off: the model gets a per-stroke mode and density, on top of the automatic
// device-profile decision the app already makes.
vendor = replaceOnce(
  vendor,
  `function _shouldRunDrip() {
    if (!this._dripCapable) return false;
    const pref = this._dripUserPref;
    if (pref === false) return false;
    return true;
}`,
  `function _shouldRunDrip() {
    // DSH: a stroke may force the run-off on or off; 'auto' leaves the device profile
    // and the panel toggle in charge.
    const mode = this._mpxDripMode;
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    if (!this._dripCapable) return false;
    const pref = this._dripUserPref;
    if (pref === false) return false;
    return true;
}`,
  'drip mode override',
)
vendor = replaceOnce(
  vendor,
  `    const spawnInterval = DRIP_SPAWN_INTERVAL_PX_BASE
        + (DRIP_SPAWN_INTERVAL_PX_RANGE * (1 - wet));    // 湿度低 → 间隔更稀
    if (this._dripSpawnAccumPx < spawnInterval) return;`,
  `    // DSH: dripAmount > 1 spawns more often, < 1 more rarely, 0 never.
    const dripAmount = (typeof this._mpxDripAmount === 'number' && this._mpxDripAmount >= 0)
        ? this._mpxDripAmount : 1;
    if (dripAmount <= 0) return;
    const spawnInterval = (DRIP_SPAWN_INTERVAL_PX_BASE
        + (DRIP_SPAWN_INTERVAL_PX_RANGE * (1 - wet))) / dripAmount;    // 湿度低 → 间隔更稀
    if (this._dripSpawnAccumPx < spawnInterval) return;`,
  'drip spawn density',
)
vendor = replaceOnce(
  vendor,
  `    const maxParticles = Math.round(
        DRIP_MAX_PARTICLES_MIN + (DRIP_MAX_PARTICLES_MAX - DRIP_MAX_PARTICLES_MIN) * wet
    );`,
  `    const maxParticles = Math.round(
        (DRIP_MAX_PARTICLES_MIN + (DRIP_MAX_PARTICLES_MAX - DRIP_MAX_PARTICLES_MIN) * wet) * dripAmount
    );`,
  'drip particle cap',
)

vendor = vendor.split('icons/save.svg').join(dataUri('icons/save.svg'))
vendor = vendor.split('icons/eyedropper-cursor.svg').join(dataUri('icons/eyedropper-cursor.svg'))

// ------------------------------------------------------------------ api tail

const API_TAIL = `

// ===================== DSH integration surface =====================
// Appended to js/app.js; everything here shares its scope.

function __mpxCurrentStrength() {
    const state = getCurrentState();
    return state.mixStrength ?? state.strength ?? null;
}

function __mpxState() {
    const livePainter = __mpxPainter();
    return {
        canvas: { width: mixCanvas.width, height: mixCanvas.height },
        mask: __mpxMask,
        engine: currentEngine,
        tool: isRectSelectMode ? 'rectSelect' : (isEyedropperMode ? 'eyedropper' : currentTool),
        brush: {
            type: currentBrush.type,
            size: brushSize,
            spacingRatio: toolStates.brush.spacingRatio,
            pressureEnabled: pressureEnabled,
        },
        concentration: __mpxCurrentStrength(),
        mixStrength: livePainter ? livePainter.getMixStrength() : null,
        wetness: toolStates.watercolor.wetness,
        colors: { foreground: foregroundColor, background: backgroundColor },
        palette: currentPalette,
        history: {
            length: livePainter ? livePainter.getHistoryLength() : 0,
            step: livePainter ? livePainter.getHistoryStep() : 0,
        },
        drip: {
            mode: livePainter && livePainter._mpxDripMode ? livePainter._mpxDripMode : 'auto',
            amount: livePainter && Number.isFinite(livePainter._mpxDripAmount) ? livePainter._mpxDripAmount : 1,
            capable: Boolean(livePainter && livePainter._dripCapable),
        },
    };
}

function __mpxSnapshot(type, quality) {
    const livePainter = __mpxPainter();
    if (!livePainter) return null;
    try {
        return quality === undefined
            ? livePainter.toDataURL(type || 'image/png')
            : livePainter.toDataURL(type, quality);
    } catch (error) {
        console.warn('[mpx] snapshot failed', error);
        return null;
    }
}

function __mpxNormalizePoints(points) {
    const out = [];
    if (!Array.isArray(points)) return out;
    for (const point of points) {
        let x, y, pressure = 1;
        if (Array.isArray(point)) {
            x = Number(point[0]); y = Number(point[1]);
            if (point.length > 2) pressure = Number(point[2]);
        } else if (point && typeof point === 'object') {
            x = Number(point.x); y = Number(point.y);
            if (point.pressure != null) pressure = Number(point.pressure);
        } else continue;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (!Number.isFinite(pressure)) pressure = 1;
        out.push({ x, y, pressure: Math.max(0, Math.min(1, pressure)) });
    }
    return out;
}

function __mpxStampSpacing(size, brushType, spacingOverride) {
    const baseSpacing = brushType === 'dry' ? size * 0.15
        : brushType === 'splatter' ? size * 0.3
        : size * 0.25;
    const sizeFalloff = brushType === 'watercolor' ? 20 / Math.max(20, size) : 1.0;
    // An explicit spacing (the panel slider as a percentage, so 1% = 0.01) has to beat the
    // automatic floor below: otherwise 1% on a small flat brush — the pencil setting — would
    // be flattened onto the same 2.5px as 5% and the slider would do nothing.
    if (Number.isFinite(spacingOverride)) {
        return Math.max(1, baseSpacing * Math.max(0.001, Math.min(1, spacingOverride)) * sizeFalloff);
    }
    const spacingRatio = brushType === 'watercolor' ? 0.35 : brushSpacingRatio;
    const smallBrushFloor = Math.min(2.5, size * 0.3);
    return Math.max(1, Math.max(size * 0.05 * sizeFalloff, smallBrushFloor), baseSpacing * spacingRatio * sizeFalloff);
}

// One animation frame, so the wet/deposit passes can run between stamp batches.
function __mpxNextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

async function __mpxStroke(points, options) {
    const livePainter = __mpxPainter();
    if (!livePainter) return { ok: false, reason: 'canvas-not-ready' };
    // Tell the recorder the picture is about to change: a stroke is synchronous, so the
    // scheduler never shows it as work in progress.
    try { __mpxRecorder.poke(); } catch (_error) {}
    const opts = options || {};
    const path = __mpxNormalizePoints(points);
    if (!path.length) return { ok: false, reason: 'no-usable-points' };
    const mode = opts.tool === 'smudge' ? 'smudge' : 'brush';
    if (mode === 'smudge' && path.length < 2) return { ok: false, reason: 'smudge-needs-two-points' };

    // A hand stroke deposits at full pressure unless the user turned the pen on.
    // Inventing a taper here is what made agent strokes look thinner and paler than
    // the user's own, so follow the panel's setting (opts.usePressure can override).
    const usePressure = opts.usePressure === true || pressureEnabled === true;
    if (!usePressure) {
        for (const point of path) point.pressure = 1;
    } else {
        // Pressure response is a curve, not a straight line: a linear ramp looks even
        // through the middle and snaps at the ends. The presets trade width against
        // taper, and every one keeps full pressure at 1.
        const curves = {
            linear: (p) => p,
            soft: (p) => p * p * (3 - 2 * p),
            firm: (p) => Math.pow(p, 0.55),
            ink: (p) => Math.pow(p, 2.2),
        };
        const curve = curves[opts.pressureCurve] || curves.linear;
        for (const point of path) point.pressure = curve(Math.max(0, Math.min(1, point.pressure)));
    }

    const color = typeof opts.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(opts.color)
        ? opts.color
        : foregroundColor;
    const size = Number.isFinite(Number(opts.size)) ? Math.max(1, Number(opts.size)) : brushSize;
    const brushType = typeof opts.brushType === 'string' ? opts.brushType : currentBrush.type;
    // Optional per-stroke spacing, in percent of the brush size like the panel slider.
    const spacingPercent = Number(opts.spacing);
    const spacingOverride = Number.isFinite(spacingPercent) ? spacingPercent / 100 : undefined;

    const previousTool = currentTool;
    const previousSize = brushSize;
    const previousBrushType = currentBrush.type;
    const previousMixStrength = livePainter.baseMixStrength;
    const previousWetness = toolStates.watercolor.wetness;
    // Per-stroke paint body: concentration is the shader's mix strength, wetness is the
    // wet-paper uniform. Both are restored after the stroke so the panel keeps its sliders.
    const strokeStrength = Number.isFinite(Number(opts.strength))
        ? mixSliderToStrength(Math.max(1, Math.min(100, Number(opts.strength))))
        : previousMixStrength;
    const strokeWetness = Number.isFinite(Number(opts.wetness))
        ? Math.max(0, Math.min(100, Number(opts.wetness)))
        : previousWetness;
    currentTool = mode;
    currentBrush.type = brushType;
    brushSize = size;
    // Drip run-off: automatic by default (device profile + the panel toggle) and
    // scaled by wetness. A stroke may override the mode and the density; both are put
    // back afterwards so the panel keeps whatever the user chose.
    const previousDripMode = livePainter._mpxDripMode;
    const previousDripAmount = livePainter._mpxDripAmount;
    try {
        if (opts.drip === 'on' || opts.drip === 'off' || opts.drip === 'auto') livePainter._mpxDripMode = opts.drip;
        const dripAmount = Number(opts.dripAmount);
        if (Number.isFinite(dripAmount)) livePainter._mpxDripAmount = Math.max(0, Math.min(2, dripAmount));
        livePainter.baseMixStrength = strokeStrength;
        if (typeof livePainter.setWetness === 'function') livePainter.setWetness(strokeWetness / 100);
    } catch (_error) {}

    let spacing = __mpxStampSpacing(size, brushType, spacingOverride);
    // A long path at 1% would need tens of thousands of stamps and stall the panel for the
    // best part of a minute; relax the spacing instead, so one stroke stays inside the
    // frame budget. Short strokes — the ones the pencil setting is for — are untouched.
    {
        let length = 0;
        for (let index = 1; index < path.length; index += 1) {
            length += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
        }
        const MAX_STAMPS_PER_STROKE = 6000;
        if (length > 0 && length / spacing > MAX_STAMPS_PER_STROKE) spacing = length / MAX_STAMPS_PER_STROKE;
    }
    const first = path[0];
    let stamps = 0;
    // Pace the stamps across animation frames the way a hand stroke arrives: the wet
    // paper, deposit colour and drip passes all accumulate per frame, so painting a
    // whole path inside one frame reads much drier than the same path drawn by hand.
    // Capped at ~16 frames: enough rounds for the wet passes to behave like a hand
    // stroke, short enough that a user undo cannot arrive in the middle of one.
    let batch = 1;
    let sinceFrame = 0;
    let releaseClip;
    try {
        if (opts.clip) releaseClip = __mpxClipFill(livePainter.gl, opts.clip);
        beginStroke(mode, color, first.x, first.y, first.pressure);
        if (mode === 'smudge') {
            // The app's smudge walks the segment itself, stepping by its own spacing.
            // It never records path points, so without this the stroke would not be
            // committed to history (and therefore not undoable).
            batch = Math.max(1, Math.ceil((path.length - 1) / 16));
            let previousX = first.x, previousY = first.y;
            addStrokePoint(first.x, first.y);
            for (let index = 1; index < path.length; index += 1) {
                const target = path[index];
                smudgeAlongPath(previousX, previousY, target.x, target.y, target.pressure);
                addStrokePoint(target.x, target.y);
                previousX = target.x; previousY = target.y; stamps += 1;
                sinceFrame += 1;
                if (sinceFrame >= batch) {
                    sinceFrame = 0;
                    livePainter.flush();
                    await __mpxNextFrame();
                }
            }
        } else {
            // Pre-build the stamp list so the frame budget is known up front.
            const planned = [{ x: first.x, y: first.y, pressure: first.pressure }];
            let lastX = first.x, lastY = first.y, lastPressure = first.pressure;
            for (let index = 1; index < path.length; index += 1) {
                const target = path[index];
                const dx = target.x - lastX;
                const dy = target.y - lastY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < 1e-4) { lastPressure = target.pressure; continue; }
                const steps = Math.max(1, Math.ceil(distance / spacing));
                for (let step = 1; step <= steps; step += 1) {
                    const ratio = step / steps;
                    planned.push({
                        x: lastX + dx * ratio,
                        y: lastY + dy * ratio,
                        pressure: lastPressure + (target.pressure - lastPressure) * ratio,
                    });
                }
                lastX = target.x; lastY = target.y; lastPressure = target.pressure;
            }
            batch = Math.max(1, Math.ceil(planned.length / 16));
            let previous = planned[0];
            drawBrush(previous.x, previous.y, color, previous.x, previous.y, previous.pressure);
            addStrokePoint(previous.x, previous.y);
            stamps += 1;
            for (let index = 1; index < planned.length; index += 1) {
                const point = planned[index];
                drawBrush(point.x, point.y, color, previous.x, previous.y, point.pressure);
                addStrokePoint(point.x, point.y);
                previous = point;
                stamps += 1;
                sinceFrame += 1;
                if (sinceFrame >= batch) {
                    sinceFrame = 0;
                    livePainter.flush();
                    await __mpxNextFrame();
                }
            }
        }
        livePainter.flush();
        endStroke();
    } catch (error) {
        console.warn('[mpx] stroke failed', error);
        try { if (livePainter.notifyStrokeEnd) livePainter.notifyStrokeEnd(); } catch (_error) {}
        currentTool = previousTool;
        brushSize = previousSize;
        currentBrush.type = previousBrushType;
        livePainter.baseMixStrength = previousMixStrength;
        try { if (typeof livePainter.setWetness === 'function') livePainter.setWetness(previousWetness / 100); } catch (_e) {}
        try { livePainter._mpxDripMode = previousDripMode; livePainter._mpxDripAmount = previousDripAmount; } catch (_e) {}
        return { ok: false, reason: 'stroke-failed', message: String(error && error.message || error) };
    } finally {
        if (releaseClip) releaseClip();
    }
    currentTool = previousTool;
    brushSize = previousSize;
    currentBrush.type = previousBrushType;
    livePainter.baseMixStrength = previousMixStrength;
    try { if (typeof livePainter.setWetness === 'function') livePainter.setWetness(previousWetness / 100); } catch (_error) {}
    try { livePainter._mpxDripMode = previousDripMode; livePainter._mpxDripAmount = previousDripAmount; } catch (_error) {}
    return {
        ok: true, stamps, color, size, brushType, tool: mode,
        frames: Math.ceil(stamps / batch),
        strength: Number.isFinite(Number(opts.strength)) ? Number(opts.strength) : null,
        wetness: Number.isFinite(Number(opts.wetness)) ? Number(opts.wetness) : null,
    };
}

// Exact canvas pixels, for reading what colour a region actually is.
function __mpxSample(points) {
    const livePainter = __mpxPainter();
    if (!livePainter) return [];
    const width = mixCanvas.width;
    const height = mixCanvas.height;
    try { if (typeof livePainter.flush === 'function') livePainter.flush(); } catch (_error) {}
    const out = [];
    for (const point of Array.isArray(points) ? points.slice(0, 24) : []) {
        const rawX = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
        const rawY = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
        if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
        const x = Math.max(0, Math.min(width - 1, Math.round(rawX)));
        const y = Math.max(0, Math.min(height - 1, Math.round(rawY)));
        try {
            const px = livePainter.readPixelByte(x, y);
            const hex = '#' + [px.r, px.g, px.b]
                .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
                .join('');
            out.push({ x, y, hex, rgb: [px.r, px.g, px.b] });
        } catch (error) {
            console.warn('[mpx] sample failed', error);
        }
    }
    return out;
}

function __mpxSaveNow() {
    const livePainter = __mpxPainter();
    if (!livePainter) return false;
    try {
        const dataURL = livePainter.toDataURL('image/webp', 1.0);
        if (!dataURL) return false;
        paletteStorage.save(dataURL);
        return true;
    } catch (error) {
        console.warn('[mpx] save failed', error);
        return false;
    }
}

function __mpxLoadSaved() {
    return new Promise((resolve) => {
        let dataURL = null;
        try { dataURL = paletteStorage.load(); } catch (_error) { dataURL = null; }
        const livePainter = __mpxPainter();
        if (!dataURL || !livePainter) { resolve(false); return; }
        const image = new Image();
        image.onload = () => {
            try {
                const scratch = document.createElement('canvas');
                scratch.width = mixCanvas.width;
                scratch.height = mixCanvas.height;
                const context = scratch.getContext('2d');
                context.drawImage(image, 0, 0, scratch.width, scratch.height);
                const data = context.getImageData(0, 0, scratch.width, scratch.height);
                livePainter.writeFromPixels(data.data, scratch.width, scratch.height);
                livePainter.flush();
                livePainter.pushHistoryFrame();
                resolve(true);
            } catch (error) {
                console.warn('[mpx] restore failed', error);
                resolve(false);
            }
        };
        image.onerror = () => resolve(false);
        image.src = dataURL;
    });
}

function __mpxClearCanvas() {
    const livePainter = __mpxPainter();
    if (!livePainter) return false;
    livePainter.clear(CANVAS_BG);
    livePainter.flush();
    livePainter.pushHistoryFrame();
    return true;
}

// Canvas size is a document property the user sets explicitly, exactly like the
// upstream panel: the app's own _commitResize() resamples the painting, rebuilds the
// painter, resets history and persists the width. Nothing here reacts to the window.
let __mpxResizeBusy = false;
let __mpxResizePending = null;

// Mirrors _commitResize(): RESIZE_MIN of container width maps to a 680x572 bitmap.
const __MPX_BASE_CANVAS = { width: 680, height: 572 };

// painter is an implicit global in app.js: initCanvas assigns it and no declaration
// exists, so reading the identifier before initApp() throws ReferenceError. Resolve it
// through a guarded read, with the global object as a fallback.
function __mpxPainter() {
    try {
        return painter || null;
    } catch (_error) {
        return globalThis.painter || null;
    }
}

function __mpxBounds() {
    return { min: RESIZE_MIN, max: RESIZE_MAX };
}

function __mpxTargetPixels(width) {
    const clamped = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(width)));
    return {
        width: Math.round(__MPX_BASE_CANVAS.width * clamped / RESIZE_MIN),
        height: Math.round(__MPX_BASE_CANVAS.height * clamped / RESIZE_MIN),
    };
}

async function __mpxResizeTo(width) {
    const target = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(width)));
    if (__mpxResizeBusy) { __mpxResizePending = target; return { ok: false, reason: 'busy' }; }
    if (Math.abs(target - _containerMaxWidth) < 1) {
        return { ok: true, resized: false, width: target, canvas: { width: mixCanvas.width, height: mixCanvas.height } };
    }
    const livePainter = __mpxPainter();
    if (!livePainter) return { ok: false, reason: 'canvas-not-ready' };
    __mpxResizeBusy = true;
    try {
        // An untouched canvas has nothing to preserve: the app's readback of an
        // un-rendered framebuffer is black, so resample-then-clear is the honest path.
        const untouched = typeof livePainter.getHistoryLength === 'function'
            && livePainter.getHistoryLength() <= 1;
        try { livePainter.flush(); } catch (_error) {}
        await _commitResize(target);
        if (__mpxMask) __mpxSetMask(__mpxMask);
        if (untouched) {
            const fresh = __mpxPainter();
            if (fresh) {
                fresh.clear(CANVAS_BG);
                fresh.flush();
                fresh.pushHistoryFrame();
            }
        }
        return { ok: true, resized: true, width: target, canvas: { width: mixCanvas.width, height: mixCanvas.height } };
    } catch (error) {
        console.warn('[mpx] canvas resize failed', error);
        return { ok: false, reason: 'failed', message: String(error && error.message || error) };
    } finally {
        __mpxResizeBusy = false;
        const next = __mpxResizePending;
        __mpxResizePending = null;
        if (next !== null) window.setTimeout(() => { __mpxResizeTo(next); }, 120);
    }
}

// --------------------------- stroke recording (bypass capture) ---------------------------

// Record the canvas while it is being painted, without touching the history stack.
//
// The undo stack only keeps ~50 raster frames and evicts the oldest, so a replay
// rebuilt from it starts mid-painting. This path never reads the stack: it pulls
// frames from a canvas stream on scheduler ticks that have real paint work behind
// them, and pauses the encoder while the picture stands still, so idle time costs
// neither frames nor bitrate. Frames stay on the GPU path - MediaRecorder encodes
// them in the browser, nothing is copied per frame to JS.
const __mpxRecorder = (function () {
    const TASK_NAME = 'dsh-recorder';
    const IDLE_MS = 700;
    /** How long the picture may stand still before that time is cut out of the clip. */
    const STILL_MS = 200;
    const BITRATE = 3000000;
    const MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

    let phase = 'idle';          // idle | recording | paused | finishing
    let stream = null;
    let track = null;
    let encoder = null;
    let mime = '';
    let chunks = [];
    let startedAt = 0;
    let lastPaintAt = 0;
    let pausedSince = 0;
    let pausedMs = 0;
    let frameCount = 0;
    let resolveStop = null;
    // Last time something was painted. An agent stroke is synchronous and does not keep
    // a scheduler task alive, so the surface pokes this directly; otherwise a fast stroke
    // would fall between ticks and the encoder would never be handed a frame.
    let lastActivityAt = 0;
    // Duplicate frames are pure waste: a tick where the picture is byte-identical adds
    // nothing but bitrate. A 48x48 signature decides whether to hand the encoder a frame.
    const SIG_SIZE = 48;
    let sigCanvas = null;
    let sigCtx = null;
    let lastSig = -1;
    let lastChangeAt = 0;
    let skippedFrames = 0;

    function frameSignature() {
        try {
            if (!sigCanvas) {
                sigCanvas = window.document.createElement('canvas');
                sigCanvas.width = SIG_SIZE;
                sigCanvas.height = SIG_SIZE;
                sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
            }
            sigCtx.drawImage(mixCanvas, 0, 0, SIG_SIZE, SIG_SIZE);
            const data = sigCtx.getImageData(0, 0, SIG_SIZE, SIG_SIZE).data;
            let hash = 2166136261;
            for (let i = 0; i < data.length; i += 12) {
                hash ^= data[i] + (data[i + 1] << 8) + (data[i + 2] << 16);
                hash = Math.imul(hash, 16777619);
            }
            return hash >>> 0;
        } catch (_error) {
            return 0; // no signature available: keep capturing rather than stall
        }
    }

    function supported() {
        return !!(window.MediaRecorder && typeof mixCanvas.captureStream === 'function');
    }

    function pickMime() {
        for (const type of MIMES) {
            try { if (MediaRecorder.isTypeSupported(type)) return type } catch (_error) {}
        }
        return '';
    }

    // The app merges every continuous loop into one scheduler; a tick where no other
    // task is active means the picture is not changing.
    function paintingNow() {
        try {
            if (typeof FrameScheduler === 'undefined' || !FrameScheduler._list) return true;
            const tasks = FrameScheduler._list();
            for (const task of tasks) {
                if (task.active && task.name !== TASK_NAME) return true;
            }
            return false;
        } catch (_error) {
            return true;
        }
    }

    function release() {
        try {
            if (typeof FrameScheduler !== 'undefined' && FrameScheduler.has(TASK_NAME)) {
                FrameScheduler.unregister(TASK_NAME);
            }
        } catch (_error) {}
        try { if (track) track.stop() } catch (_error) {}
        try { if (stream) stream.getTracks().forEach((t) => t.stop()) } catch (_error) {}
        track = null;
        stream = null;
        encoder = null;
    }

    function tick() {
        if (phase !== 'recording' && phase !== 'paused') return;
        const now = performance.now();
        // A stroke pokes lastActivityAt; the scheduler's own tasks cover hand painting and
        // the wet passes that keep running after a stroke.
        const busy = paintingNow() || (now - lastActivityAt < IDLE_MS);
        if (!busy) {
            if (phase === 'recording' && now - lastPaintAt >= IDLE_MS) {
                try { encoder.pause() } catch (_error) {}
                phase = 'paused';
                pausedSince = now;
            }
            return;
        }
        const sig = frameSignature();
        if (sig !== 0 && sig === lastSig) {
            // The picture is standing still between two strokes. Pausing the encoder here
            // is what removes that time from the clip: a paused recorder does not advance
            // its timeline, so the replay runs at the speed of the work.
            skippedFrames += 1;
            if (phase === 'recording' && now - lastChangeAt >= STILL_MS) {
                try { encoder.pause() } catch (_error) {}
                phase = 'paused';
                pausedSince = now;
            }
            return;
        }
        if (phase === 'paused') {
            try { encoder.resume() } catch (_error) {}
            pausedMs += now - pausedSince;
            phase = 'recording';
        }
        lastPaintAt = now;
        lastActivityAt = now;
        lastChangeAt = now;
        lastSig = sig;
        try {
            track.requestFrame();
            frameCount += 1;
        } catch (_error) {}
    }

    /** Tell the recorder that the picture just changed (called by the stroke surface). */
    function poke() {
        if (phase === 'recording' || phase === 'paused') lastActivityAt = performance.now();
    }

    function start() {
        if (phase !== 'idle') return { ok: false, reason: 'busy', phase: phase };
        if (!supported()) return { ok: false, reason: 'unsupported' };
        try {
            mime = pickMime();
            stream = mixCanvas.captureStream(0);
            track = stream.getVideoTracks()[0];
            if (!track) {
                release();
                return { ok: false, reason: 'no-track' };
            }
            const options = { videoBitsPerSecond: BITRATE };
            if (mime) options.mimeType = mime;
            encoder = new MediaRecorder(stream, options);
            chunks = [];
            frameCount = 0;
            pausedMs = 0;
            lastSig = -1;
            lastChangeAt = startedAt;
            skippedFrames = 0;
            startedAt = performance.now();
            lastPaintAt = startedAt;
            lastActivityAt = startedAt;
            encoder.ondataavailable = (event) => {
                if (event.data && event.data.size) chunks.push(event.data);
            };
            encoder.onstop = () => {
                const type = mime || 'video/webm';
                const blob = new Blob(chunks, { type: type });
                const result = {
                    ok: true,
                    blob: blob,
                    mime: type,
                    bytes: blob.size,
                    frames: frameCount,
                    durationMs: Math.max(0, performance.now() - startedAt - pausedMs),
                };
                chunks = [];
                phase = 'idle';
                release();
                const resolve = resolveStop;
                resolveStop = null;
                if (resolve) resolve(result);
            };
            encoder.start(1000);
            phase = 'recording';
            FrameScheduler.register(TASK_NAME, tick, 90);
            return { ok: true, mime: mime || 'video/webm' };
        } catch (error) {
            release();
            phase = 'idle';
            return { ok: false, reason: 'start-failed', message: String(error && error.message || error) };
        }
    }

    function stop() {
        if (phase === 'idle' || phase === 'finishing') return Promise.resolve({ ok: false, reason: 'idle' });
        const wasPaused = phase === 'paused';
        phase = 'finishing';
        return new Promise((resolve) => {
            resolveStop = resolve;
            // A paused encoder has been handed nothing since it paused, and stopping it
            // there can finalize an empty clip: wake it and push one last frame first.
            try {
                if (wasPaused) encoder.resume();
                if (track) track.requestFrame();
                frameCount += 1;
            } catch (_error) {}
            try { encoder.requestData() } catch (_error) {}
            try {
                encoder.stop();
            } catch (_error) {
                resolve({ ok: false, reason: 'stop-failed' });
            }
        });
    }

    function state() {
        return {
            phase: phase,
            supported: supported(),
            mime: mime || 'video/webm',
            frames: frameCount,
            skipped: skippedFrames,
            elapsedMs: phase === 'idle' ? 0 : Math.max(0, performance.now() - startedAt - pausedMs),
        };
    }

    return { start: start, stop: stop, state: state, poke: poke };
})();

return {
    initApp,
    recorder: __mpxRecorder,
    nextFrame: __mpxNextFrame,
    flush: function () {
        // Commit whatever the painter still has queued, so a capture cannot read a
        // framebuffer that is one frame behind the strokes the state already reports.
        const livePainter = __mpxPainter();
        if (livePainter && typeof livePainter.flush === 'function') livePainter.flush();
    },
    el: mixCanvas,
    snapshot: __mpxSnapshot,
    state: __mpxState,
    setMask: __mpxSetMask,
    stroke: __mpxStroke,
    sample: __mpxSample,
    saveNow: __mpxSaveNow,
    loadSaved: __mpxLoadSaved,
    clearCanvas: __mpxClearCanvas,
    undo: function () { try { undo(); } catch (_error) {} },
    redo: function () { try { redo(); } catch (_error) {} },
    bounds: __mpxBounds,
    targetPixels: __mpxTargetPixels,
    currentWidth: function () { return _containerMaxWidth; },
    dispose: function () {
        frameClock.dispose();
        const livePainter = __mpxPainter();
        try { if (livePainter && typeof livePainter.dispose === 'function') livePainter.dispose(); } catch (_error) {}
    },
    widthFromPixels: function (pixels) {
        const clamped = Math.max(1, Math.round(Number(pixels) || 0));
        return Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(clamped * RESIZE_MIN / __MPX_BASE_CANVAS.width)));
    },
    resizeTo: function (width) { return __mpxResizeTo(width); },
    // The app's own DOM pass misses some nodes depending on init order; run it again.
    translateDom: function () {
        try { I18N.applyToDOM(); return true; } catch (error) {
            console.warn('[mpx] translateDom failed', error);
            return false;
        }
    },
    getLanguage: function () {
        try { return I18N.getLang(); } catch (_error) { return 'en'; }
    },
};
`

vendor = replaceOnce(vendor, 'gl.shaderSource(shader, source);', 'gl.shaderSource(shader, type === gl.FRAGMENT_SHADER ? __mpxMaskShader(source) : source);', 'paint mask shader')
vendor = replaceOnce(vendor, '        return program;', '        __mpxRegisterMask(gl, program);\n        return program;', 'paint mask uniforms')
vendor += '\n' + readFileSync(join(HERE, 'mask-runtime.js'), 'utf8') + '\n'
vendor += API_TAIL

// ------------------------------------------------------------------ css

const CSS_FILES = [
  'css/base.css',
  'css/header.css',
  'css/palette.css',
  'css/controls.css',
  'css/mix-area.css',
  'css/modals.css',
]

let css = CSS_FILES.map((rel) => `/* ==== ${rel} ==== */\n${read(rel)}`).join('\n')
// The app declares its palette on :root. Everything in the shadow tree needs it,
// including the settings dialog, which is a sibling of the panel body.
css = css.replace(/^:root\s*\{/m, ':host, .mpx-body {')
css = css.replace(/^body\s*\{/m, '.mpx-body {')
css = css.replace(/\bbody:not\(\.app-ready\)/g, '.mpx-body:not(.app-ready)')

// The upstream app shipped a desktop host bridge. This bundle has no host: drop
// the import button and the workflow strings outright, and reword the comments that
// mention the host so the public build never names it. `rectSelectBtn` stays because
// the app repurposes it as the save-as-PNG button when no host is present.
markup = markup.replace(/[ \t]*<button id="importBtn"[\s\S]*?<\/button>\r?\n?/, '')
markup = markup
  .replace('data-i18n-title="rectSelectTool" title="Select area to PS"', 'title="Save as PNG"')

// The upstream app was a page; in a panel every viewport-anchored layer anchors to the panel.
css = css.replace(/position:\s*fixed/g, 'position: absolute')
// CSS-referenced icons (mask-image on the caret, cursor images) are fetched by the
// browser, so their relative path resolves against the panel's origin and 404s there.
// Inline them the same way the markup icons are inlined.
for (const match of new Set([...css.matchAll(/url\((['"]?)\.\.\/icons\/([^'")]+)\1\)/g)].map((hit) => hit[0]))) {
  const rel = match.match(/icons\/([^'")]+)/)[1]
  css = css.split(match).join(`url("${dataUri('icons/' + rel)}")`)
}
if (/url\(['"]?\.\.\/icons\//.test(css)) problems.push('css still references a relative icon path')

// The boot splash still carries the upstream brand; the panel is its own product now.
markup = markup.replace(/(<div class="icon">)[^<]*(<\/div>)/, '$1🐟$2')
markup = markup.replace(/(<div class="title">)Mixbox Palette(<\/div>)/, '$1肥鱼画室$2')

let headStyle = extractHeadStyle(appHtml)
headStyle = headStyle.replace(/\bbody:not\(\.app-ready\)/g, '.mpx-body:not(.app-ready)')
headStyle = headStyle.replace(/position:\s*fixed/g, 'position: absolute')

const OVERRIDES = `
/* ==== DSH bundle overrides ==== */
:host { display: block; height: 100%; }
/* The app drew itself as a card on a page: 12px gutters and a drop shadow. A sidebar
   panel is a column of the page, so the card goes away — but the panel keeps the app's
   own surface colour instead of letting the host's darker sidebar show through. */
.mpx-body {
    position: relative;
    isolation: isolate;
    height: 100%;
    min-height: 0 !important;
    padding: 0 !important;
    background-color: var(--panel, #252729) !important;
    overflow: auto;
}
.container {
    width: 100% !important;
    max-width: none !important;
    padding: 10px 12px 12px;
    background-color: transparent !important;
    box-shadow: none !important;
    border-radius: 0 !important;
}
#appLoader { inset: 0; border-radius: 8px; }
#engineBtn { display: none !important; }
.github-link { display: none !important; }
/* The panel is already a column the host sizes; these two are the upstream
   page's own edge-drag affordances and its "focus is captured" hint bar. The size
   control below replaces the drag handles. */
#focusIndicator { display: none !important; }
.resize-handle { display: none !important; }

/* ==== canvas size control ==== */
/* The layout column keeps following the canvas width, so every row lines up with the
   canvas. What must not grow are the elements themselves: the swatch grid stretched
   with the column (1fr tracks), so its tracks are capped and the whole palette card
   hugs them, centred in the row instead of spreading across it. */
.color-picker {
    grid-template-columns: repeat(8, minmax(0, var(--mpx-swatch-size, 52px)));
    width: max-content;
    max-width: 100%;
    margin-inline: auto;
}
/* Sits in the header's title cell and borrows .lang-btn / .zoom-btn metrics so it
   reads as one of the panel's own header buttons. */
.mpx-size-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--border, #41454a);
    border-radius: 4px;
    background: var(--surface, #2c2f32);
    color: var(--muted, #a5aab0);
    font: inherit;
    font-size: 11px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
}
.mpx-size-btn:hover { background-color: #3a3d41; color: var(--text, #e8eaed); }
.mpx-size-btn:focus-visible { outline: 2px solid var(--accent, #579ce0); outline-offset: 1px; }
.mpx-size-glyph { font-size: 12px; line-height: 1; }
.mpx-reload-btn {
    margin-left: 4px;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--border, #41454a);
    border-radius: 4px;
    background: var(--surface, #2c2f32);
    color: var(--muted, #a5aab0);
    font: inherit;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    vertical-align: top;
}
.mpx-reload-btn:hover { background-color: #3a3d41; color: var(--text, #e8eaed); }
.mpx-reload-btn:disabled { opacity: 0.6; cursor: default; }
.mpx-reload-menu {
    position: absolute;
    z-index: 45;
    display: flex;
    flex-direction: column;
    min-width: 150px;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid var(--border, #41454a);
    background: #2b2d30;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.mpx-reload-menu[hidden] { display: none; }
.mpx-reload-menu button {
    padding: 7px 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
}
.mpx-reload-menu button:hover { background: #3a3d41; }
.mpx-modal {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
}
.mpx-modal[hidden] { display: none; }
.mpx-modal-card {
    width: min(340px, calc(100% - 32px));
    max-height: calc(100% - 32px);
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    border-radius: 10px;
    border: 1px solid var(--border, #41454a);
    background: var(--surface, #2c2f32);
    color: var(--text, #e8eaed);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.mpx-modal-card h3 { margin: 0; font-size: 14px; font-weight: 600; }
.mpx-modal-card:focus { outline: none; }
.mpx-section {
    margin: 2px 0 0;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted, #a5aab0);
}
.mpx-divider { height: 1px; margin: 4px 0; background: var(--border, #41454a); }
.mpx-field { display: flex; align-items: center; gap: 10px; }
.mpx-field > label { flex: 1 1 auto; font-size: 12px; color: var(--muted, #a5aab0); white-space: nowrap; }
/* Rows whose control is wide (a picker, four format buttons) stack instead of squeezing
   the label into two lines inside a narrow panel. */
.mpx-field-col { flex-direction: column; align-items: stretch; gap: 6px; }
.mpx-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }
.mpx-btn-row .mpx-pick-btn { margin-left: 0; }
.mpx-seg-formats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.mpx-seg-formats button {
    padding: 0 4px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
}
.mpx-field input[type="number"] {
    width: 74px;
    padding: 4px 6px;
    text-align: right;
    font: inherit;
    font-variant-numeric: tabular-nums;
    color: inherit;
    background: var(--panel, #252729);
    border: 1px solid var(--border, #41454a);
    border-radius: 6px;
}
.mpx-seg { display: flex; gap: 4px; }
.mpx-seg button {
    height: 26px;
    padding: 0 12px;
    font: inherit;
    font-size: 12px;
    color: var(--muted, #a5aab0);
    background: transparent;
    border: 1px solid var(--border, #41454a);
    border-radius: 6px;
    cursor: pointer;
}
.mpx-seg button[aria-pressed="true"] {
    background: var(--accent, #579ce0);
    border-color: var(--accent, #579ce0);
    color: #10151c;
    font-weight: 600;
}
.mpx-mode-pill {
    /* Far right of the status row; the ask button is centred over the row. */
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 9px;
    border-radius: 11px;
    border: 1px solid var(--border, #41454a);
    background: var(--surface, #2c2f32);
    color: var(--muted, #a5aab0);
    font: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
}
.mpx-mode-pill:hover { background: #3a3d41; color: var(--text, #e8eaed); }
.mpx-mode-pill[data-live="true"] {
    color: var(--text, #e8eaed);
    border-color: var(--accent, #579ce0);
}
.mpx-mode-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #6b7280;
}
.mpx-mode-pill[data-live="true"] .mpx-mode-dot {
    background: var(--accent, #579ce0);
    box-shadow: 0 0 6px var(--accent, #579ce0);
}
/* ==== ask-with-the-canvas ==== */
/* Centred on the status row itself, not on the space left by its siblings. */
.footer-row { position: relative; }
.mpx-ask-btn {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    height: 26px;
    padding: 0 14px;
    border-radius: 13px;
    border: 1px solid rgba(87, 156, 224, 0.55);
    background: rgba(87, 156, 224, 0.16);
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
}
.mpx-ask-btn:hover { background: rgba(87, 156, 224, 0.28); }
.mpx-ask-btn:active { background: rgba(87, 156, 224, 0.38); }
/* Sits in the status row's own flow at its left end: the ask button is absolutely
   centred over that row, so anything positioned near the middle lands on top of it.
   Classic record control: a red dot that becomes a square while recording. */
.mpx-record-btn {
    order: -1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-right: 8px;
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--border, #41454a);
    background: var(--surface, #2c2f32);
    cursor: pointer;
}
.mpx-record-btn:hover { background: #3a3d41; }
.mpx-record-btn::before {
    content: "";
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #e2483a;
    transition: width 0.12s ease, height 0.12s ease, border-radius 0.12s ease;
}
.mpx-record-btn[data-recording="true"] {
    border-color: rgba(226, 72, 58, 0.85);
}
.mpx-record-btn[data-recording="true"]::before {
    width: 10px;
    height: 10px;
    border-radius: 2px;
}
.mpx-record-btn[data-phase="finishing"]::before { opacity: 0.45; }
/* Recording has to be visible without looking at the button: a slow glow, not a blink. */
@keyframes mpx-rec-breathe {
    0%, 100% {
        box-shadow: 0 0 0 0 rgba(226, 72, 58, 0.00);
        border-color: rgba(226, 72, 58, 0.55);
    }
    50% {
        box-shadow: 0 0 0 5px rgba(226, 72, 58, 0.18);
        border-color: rgba(255, 110, 92, 0.95);
    }
}
.mpx-record-btn[data-recording="true"] {
    animation: mpx-rec-breathe 1.9s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
    .mpx-record-btn[data-recording="true"] { animation: none; box-shadow: 0 0 0 4px rgba(226, 72, 58, 0.16); }
}
/* Start / stop feedback sits over the middle of the painting, not in a corner. */
.mpx-rec-toast {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 60;
    max-width: 70%;
    padding: 10px 18px;
    border-radius: 22px;
    background: rgba(18, 20, 24, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.10);
    color: #f3f5f8;
    font: 13px/1.45 system-ui, sans-serif;
    text-align: center;
    letter-spacing: 0.02em;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, -50%) scale(0.96);
    transition: opacity 0.18s ease, transform 0.18s ease;
}
.mpx-rec-toast[data-on="true"] {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
}
/* A toast that carries a button opts back into hit-testing for that button — but only
   while it is on screen, or a hidden one would swallow painting clicks. */
.mpx-rec-toast-btn {
    pointer-events: none;
    margin-left: 10px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.32);
    background: rgba(255, 255, 255, 0.10);
    color: inherit;
    font: inherit;
    font-size: 12px;
    line-height: 1.4;
    cursor: pointer;
}
.mpx-rec-toast[data-on="true"] .mpx-rec-toast-btn { pointer-events: auto; }
.mpx-rec-toast-btn:hover { background: rgba(255, 255, 255, 0.22); }
.mpx-pick-btn {
    height: 26px;
    padding: 0 10px;
    margin-left: 6px;
    border-radius: 4px;
    border: 1px solid var(--border, #41454a);
    background: var(--surface, #2c2f32);
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
}
.mpx-pick-btn:hover { background: #3a3d41; }
.mpx-ask-pop {
    position: absolute;
    z-index: 40;
    width: min(280px, calc(100% - 24px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--border, #41454a);
    background: var(--surface, #2c2f32);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    transform: translateY(-100%);
}
.mpx-ask-pop[hidden] { display: none; }
.mpx-ask-input {
    width: 100%;
    min-height: 64px;
    resize: vertical;
    padding: 8px;
    border-radius: 8px;
    border: 1px solid var(--border, #41454a);
    background: var(--panel, #252729);
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 12px;
    line-height: 1.5;
}
.mpx-ask-input:focus { outline: 1px solid var(--accent, #579ce0); outline-offset: 1px; }
.mpx-ask-actions { display: flex; justify-content: flex-end; gap: 6px; }
.mpx-ask-actions button {
    height: 24px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid var(--border, #41454a);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
}
.mpx-ask-actions button[data-mpx-ask-send] {
    background: var(--accent, #579ce0);
    border-color: var(--accent, #579ce0);
    color: #10151c;
    font-weight: 600;
}
.mpx-modal-row { display: flex; align-items: center; gap: 10px; }
/* The slider reuses the app's own .custom-range track and thumb; the input only
   carries the value and the keyboard behaviour. */
.mpx-range-input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; }
.mpx-modal-row .custom-range-wrap { flex: 1 1 auto; min-width: 0; }
.mpx-modal-row input[type="number"] {
    width: 74px;
    padding: 4px 6px;
    text-align: right;
    font: inherit;
    font-variant-numeric: tabular-nums;
    color: inherit;
    background: var(--panel, #252729);
    border: 1px solid var(--border, #41454a);
    border-radius: 6px;
}
.mpx-hint { margin: 0; font-size: 12px; color: var(--muted, #a5aab0); }
.mpx-hint b { color: var(--text, #e8eaed); font-variant-numeric: tabular-nums; }
.mpx-actions { display: flex; justify-content: flex-end; gap: 8px; }
.mpx-actions button {
    height: 28px;
    padding: 0 14px;
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--border, #41454a);
    border-radius: 6px;
    cursor: pointer;
}
.mpx-actions button[data-mpx-apply] {
    background: var(--accent, #579ce0);
    border-color: var(--accent, #579ce0);
    color: #10151c;
    font-weight: 600;
}
.mpx-actions button:disabled { opacity: 0.55; cursor: default; }
.mpx-notice {
    position: sticky;
    bottom: 8px;
    z-index: 20;
    margin: 8px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--surface, #2c2f32);
    border: 1px solid var(--border, #41454a);
    color: var(--text, #e8eaed);
    font: 12px/1.5 system-ui, sans-serif;
    white-space: pre-wrap;
}
`

css = `${css}\n${headStyle}\n${OVERRIDES}`

// ------------------------------------------------------------------ emit

const worker = read('js/history-worker.js')
const lut = readFileSync(join(SRC, 'assets/km-lut.png')).toString('base64')
const runtime = readFileSync(join(HERE, 'runtime.js'), 'utf8')
// The plugin's own icon, so the composer chip shows the same mark as the sidebar.
const pluginIcon = `data:image/svg+xml;base64,${readFileSync(join(PKG_ROOT, 'icon.svg')).toString('base64')}`

let out = runtime
  .replace('__MPX_CSS__', JSON.stringify(css))
  .replace('__MPX_MARKUP__', JSON.stringify(markup))
  .replace('__MPX_WORKER__', JSON.stringify(worker))
  .replace('__MPX_LUT__', JSON.stringify(lut))
  .replace('__MPX_SAVE_ICON__', JSON.stringify(dataUri('icons/save.svg')))
  .replace('__MPX_PLUGIN_ICON__', JSON.stringify(pluginIcon))
  .replace('__MPX_VENDOR__', vendor)
  // The vendored i18n table still carries the upstream brand string.
  .replaceAll('🎨 Mixbox Palette', '🐟 肥鱼画室')

// The upstream app shipped a desktop host bridge. This bundle has no host, so
// its workflow strings are dead weight that would name a product we do not support:
// drop the entries outright, then reword the remaining comments that mention it.
out = out
  .replace(/^[ \t]*"(?:rectSelect|import|transfer|update)[A-Za-z]*"[ \t]*:[ \t]*"[^"\n]*",?[ \t]*\r?\n/gm, '')
  .replace(/js\/ps-bridge\.js/g, 'the host bridge')
  .replaceAll('UXP Host', 'the host')
  .replaceAll('Photoshop', 'the upstream app')

const target = join(PKG_ROOT, 'client.js')
writeFileSync(target, out, 'utf8')

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`
console.log(`source: ${SRC}`)
console.log(`client.js: ${kb(statSync(target).size)}  (css ${kb(css.length)}, markup ${kb(markup.length)}, lut ${kb(lut.length)})`)
if (problems.length) {
  console.error('\npatch problems:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('patches: ok')
