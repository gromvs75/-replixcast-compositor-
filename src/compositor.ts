import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as http from "http";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";
import type { SceneInput, ComposeRequest, VideoTransition } from "./types";

const execAsync = promisify(exec);

// ─── Reference canvas defaults ───────────────────────────────────────────────
// The editor stage typically renders at these dimensions.
// All x/y offsets stored in SceneDraft are relative to these.
const DEFAULT_REF_W = 1280;
const DEFAULT_REF_H = 720;

// ─── Output resolutions ───────────────────────────────────────────────────────
const RESOLUTIONS = {
  "720p": { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `compositor-${uuid()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)?((?:;[^,]+)*)?,([\s\S]+)$/);
    if (!match) throw new Error("Invalid data URL");
    const meta = `${match[1] || ""}${match[2] || ""}`;
    const payload = match[3] || "";
    const isBase64 = /;base64/i.test(meta);
    const buffer = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    await fs.promises.writeFile(destPath, buffer);
    return;
  }

  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        file.close();
        fs.unlinkSync(destPath);
        downloadFile(res.headers.location!, destPath).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

/** Parse first hex color from CSS gradient string */
function extractFirstColor(gradientCss: string): string {
  const match = gradientCss.match(/#([0-9a-fA-F]{3,6})/);
  return match ? match[0] : "#000000";
}

/** Parse CSS gradient into two colors and angle for ffmpeg geq gradient */
function parseLinearGradient(css: string): { angle: number; color1: string; color2: string } | null {
  const m = css.match(/linear-gradient\(\s*([\d.]+)deg\s*,\s*(#[0-9a-fA-F]{3,8})[^,]*,\s*(#[0-9a-fA-F]{3,8})/i);
  if (!m) {
    // Try "to right", "to bottom" etc.
    const m2 = css.match(/linear-gradient\(\s*to\s+(right|left|bottom|top)\s*,\s*(#[0-9a-fA-F]{3,8})[^,]*,\s*(#[0-9a-fA-F]{3,8})/i);
    if (!m2) return null;
    const dirMap: Record<string, number> = { right: 90, left: 270, bottom: 180, top: 0 };
    return { angle: dirMap[m2[1].toLowerCase()] ?? 90, color1: m2[2], color2: m2[3] };
  }
  return { angle: parseFloat(m[1]), color1: m[2], color2: m[3] };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

// ─── Per-scene compositing ────────────────────────────────────────────────────

async function composeScene(
  scene: SceneInput,
  outPath: string,
  workDir: string,
  outW: number,
  outH: number,
  refW: number,
  refH: number,
  sceneIdx: number,
): Promise<void> {
  const scaleX = outW / refW;
  const scaleY = outH / refH;

  // Download avatar video
  const avatarPath = path.join(workDir, `avatar_${sceneIdx}.mp4`);
  await downloadFile(scene.avatarVideoUrl, avatarPath);

  // Build inputs list
  const inputs: string[] = [avatarPath];
  const dur = scene.durationSeconds;

  // Download visible overlay layers
  const visibleOverlays = (scene.overlayLayers || []).filter(l => l.visible !== false && l.url);
  for (const ov of visibleOverlays) {
    const ext = ov.kind === "video" ? ".mp4" : ".png";
    const p = path.join(workDir, `overlay_${sceneIdx}_${ov.id}${ext}`);
    await downloadFile(ov.url, p);
    inputs.push(p);
  }

  // Download background image/video if needed
  let bgImagePath: string | null = null;
  let bgGradientPath: string | null = null;
  if (scene.backgroundVisible !== false && scene.backgroundType === "image" && scene.backgroundValue) {
    bgImagePath = path.join(workDir, `bg_${sceneIdx}.jpg`);
    await downloadFile(scene.backgroundValue, bgImagePath);
    inputs.unshift(bgImagePath);
  } else if (scene.backgroundVisible !== false && scene.backgroundType === "video" && scene.backgroundValue) {
    bgImagePath = path.join(workDir, `bg_${sceneIdx}.mp4`);
    await downloadFile(scene.backgroundValue, bgImagePath);
    inputs.unshift(bgImagePath);
  }

  // ── Build filter_complex ───────────────────────────────────────────────────

  const filters: string[] = [];
  let lastVideo = "";
  let inputIdx = 0;

  // ── Background ────────────────────────────────────────────────────────────
  const bgOpacity = ((scene.backgroundOpacity ?? 100) / 100).toFixed(2);
  const bpx = (scene.backgroundParams?.x ?? 0) * scaleX;
  const bpy = (scene.backgroundParams?.y ?? 0) * scaleY;
  const bpScale = scene.backgroundParams?.scale ?? 1;

  if (scene.backgroundVisible === false) {
    filters.push(`color=c=black:s=${outW}x${outH}:d=${dur}[bg]`);
    lastVideo = "[bg]";
  } else if (scene.backgroundType === "color" && scene.backgroundValue) {
    const color = scene.backgroundValue.replace("#", "0x");
    filters.push(`color=c=${color}:s=${outW}x${outH}:d=${dur},format=yuva420p[bg]`);
    lastVideo = "[bg]";
  } else if (scene.backgroundType === "gradient" && scene.backgroundValue) {
    const grad = parseLinearGradient(scene.backgroundValue);
    if (grad) {
      const c1 = hexToRgb(grad.color1);
      const c2 = hexToRgb(grad.color2);
      const angleRad = (grad.angle * Math.PI) / 180;
      const rExpr = `${c1.r}+(${c2.r - c1.r})*((X*${Math.sin(angleRad).toFixed(4)}+Y*${Math.cos(angleRad).toFixed(4)})/(W*${Math.sin(angleRad).toFixed(4)}+H*${Math.cos(angleRad).toFixed(4)}))`;
      const gExpr = `${c1.g}+(${c2.g - c1.g})*((X*${Math.sin(angleRad).toFixed(4)}+Y*${Math.cos(angleRad).toFixed(4)})/(W*${Math.sin(angleRad).toFixed(4)}+H*${Math.cos(angleRad).toFixed(4)}))`;
      const bExpr = `${c1.b}+(${c2.b - c1.b})*((X*${Math.sin(angleRad).toFixed(4)}+Y*${Math.cos(angleRad).toFixed(4)})/(W*${Math.sin(angleRad).toFixed(4)}+H*${Math.cos(angleRad).toFixed(4)}))`;
      filters.push(`color=s=${outW}x${outH}:d=${dur}[bgbase];[bgbase]geq=r='${rExpr}':g='${gExpr}':b='${bExpr}'[bg]`);
    } else {
      const fallback = extractFirstColor(scene.backgroundValue).replace("#", "0x");
      filters.push(`color=c=${fallback}:s=${outW}x${outH}:d=${dur}[bg]`);
    }
    lastVideo = "[bg]";
  } else if ((scene.backgroundType === "image" || scene.backgroundType === "video") && bgImagePath) {
    const bgIdx = inputIdx++;
    if (scene.backgroundType === "image") {
      filters.push(
        `[${bgIdx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},` +
        `translate=x=${bpx}:y=${bpy},scale=iw*${bpScale}:ih*${bpScale},` +
        `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS,` +
        `trim=duration=${dur},loop=loop=-1:size=1,` +
        `format=yuva420p,colorchannelmixer=aa=${bgOpacity}[bg]`
      );
    } else {
      filters.push(
        `[${bgIdx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},` +
        `trim=duration=${dur},setpts=PTS-STARTPTS,` +
        `format=yuva420p,colorchannelmixer=aa=${bgOpacity}[bg]`
      );
    }
    filters.push(`color=c=black:s=${outW}x${outH}:d=${dur}[canvas];[canvas][bg]overlay=0:0[bgout]`);
    lastVideo = "[bgout]";
  } else {
    filters.push(`color=c=black:s=${outW}x${outH}:d=${dur}[bg]`);
    lastVideo = "[bg]";
  }

  // ── Avatar ────────────────────────────────────────────────────────────────
  const avatarIdx = inputIdx++;
  const ap = scene.avatarParams ?? {};
  const ax = (ap.x ?? 0) * scaleX;
  const ay = (ap.y ?? 0) * scaleY;
  const aScale = ap.scale ?? 1;

  const avatarSeek = typeof scene.avatarStartTimeSeconds === "number" && scene.avatarStartTimeSeconds > 0
    ? scene.avatarStartTimeSeconds
    : 0;

  if (scene.avatarVisible !== false) {
    const avatarH = Math.round(outH * aScale);
    const trimExpr = avatarSeek > 0
      ? `trim=start=${avatarSeek.toFixed(3)}:duration=${dur},setpts=PTS-STARTPTS,`
      : `setpts=PTS-STARTPTS,trim=duration=${dur},`;
    filters.push(`[${avatarIdx}:v]${trimExpr}scale=-2:${avatarH}[av_scaled]`);
    filters.push(
      `${lastVideo}[av_scaled]overlay=` +
      `x=(main_w-overlay_w)/2+${Math.round(ax)}:` +
      `y=(main_h-overlay_h)/2+${Math.round(ay)}` +
      `[av_out]`
    );
    lastVideo = "[av_out]";
  }

  const avatarInputIdx = avatarIdx;
  const overlayInputStartIdx = avatarInputIdx + 1;

  const visibleText = (scene.textLayers || []).filter((l) => l.visible !== false && l.content?.trim());
  const visibleShapes = (scene.shapeLayers || []).filter(
    (sl) => sl.visible !== false && (sl.kind === "rect" || sl.kind === "line")
  );

  const overlayKeyOrder = visibleOverlays.map((ov) => `overlay:${ov.id}`);
  const shapeKeyOrder = visibleShapes.map((sl) => `shape:${sl.id}`);
  const textKeyOrder = visibleText.map((tl) => `text:${tl.id}`);
  const defaultLayerOrder = [...overlayKeyOrder, ...shapeKeyOrder, ...textKeyOrder];
  const effectiveLayerOrder = scene.layerOrder?.length
    ? [
        ...scene.layerOrder.filter((key) => defaultLayerOrder.includes(key)),
        ...defaultLayerOrder.filter((key) => !scene.layerOrder?.includes(key)),
      ]
    : defaultLayerOrder;

  const overlayByKey = new Map(
    visibleOverlays.map((ov, i) => [
      `overlay:${ov.id}`,
      { layer: ov, index: i, inputIdx: overlayInputStartIdx + i },
    ])
  );
  const textByKey = new Map(visibleText.map((tl, i) => [`text:${tl.id}`, { layer: tl, index: i }]));
  const shapeByKey = new Map(visibleShapes.map((sl, i) => [`shape:${sl.id}`, { layer: sl, index: i }]));

  for (const layerKey of effectiveLayerOrder) {
    const overlayEntry = overlayByKey.get(layerKey);
    if (overlayEntry) {
      const { layer: ov, index: i, inputIdx: ovIdx } = overlayEntry;
      const ovX = Math.round((ov.x ?? 0) * scaleX);
      const ovY = Math.round((ov.y ?? 0) * scaleY);
      const ovScale = ov.scale ?? 1;
      const ovWidth = typeof ov.width === "number" ? Math.max(2, Math.round(ov.width * scaleX)) : null;
      const ovHeight = typeof ov.height === "number" ? Math.max(2, Math.round(ov.height * scaleY)) : null;
      const ovOpacity = ((ov.opacity ?? 100) / 100).toFixed(2);
      const tagIn = `ov_raw_${i}`;
      const tagOut = `ov_out_${i}`;
      const hasTimeRange = typeof ov.startTime === "number" && typeof ov.endTime === "number";
      const overlayStart = hasTimeRange ? Math.max(0, ov.startTime as number) : 0;
      const overlayEnd = hasTimeRange ? Math.max(overlayStart, ov.endTime as number) : dur;
      const overlayDuration = Math.max(0.05, overlayEnd - overlayStart);
      const animation = ov.animation || "none";
      const hasOverlayAnimation = animation !== "none";
      const enableExpr = hasTimeRange
        ? `:enable='between(t,${ov.startTime!.toFixed(3)},${ov.endTime!.toFixed(3)})'`
        : "";

      if (ov.kind === "video") {
        filters.push(
          `[${ovIdx}:v]scale=${ovWidth ?? `iw*${ovScale}`}:${ovHeight ?? "-2"},setpts=PTS-STARTPTS,trim=duration=${dur},` +
          `loop=loop=-1:size=32767:start=0[${tagIn}]`
        );
      } else if (hasOverlayAnimation) {
        // Animated image: use loop+trim+setpts so fade-in timing works correctly
        const animDuration = Math.min(0.6, overlayDuration);
        const fadeExpr = animDuration > 0
          ? `,fade=t=in:st=0:d=${animDuration.toFixed(3)}:alpha=1`
          : "";
        filters.push(
          `[${ovIdx}:v]scale=${ovWidth ?? `iw*${ovScale}`}:${ovHeight ?? "-2"},` +
          `format=rgba,colorchannelmixer=aa=${ovOpacity},` +
          `loop=loop=-1:size=1:start=0,trim=duration=${overlayDuration.toFixed(3)}` +
          `${fadeExpr},setpts=PTS-STARTPTS+${overlayStart.toFixed(3)}/TB[${tagIn}]`
        );
      } else {
        // Static image: keep a one-frame loop trimmed to the intended duration.
        // This is more stable than relying on eof_action=repeat across many PNG inputs.
        filters.push(
          `[${ovIdx}:v]scale=${ovWidth ?? `iw*${ovScale}`}:${ovHeight ?? "-2"},` +
          `format=rgba,colorchannelmixer=aa=${ovOpacity},` +
          `loop=loop=-1:size=1:start=0,trim=duration=${overlayDuration.toFixed(3)},` +
          `setpts=PTS-STARTPTS+${overlayStart.toFixed(3)}/TB[${tagIn}]`
        );
      }
      const animProgress =
        hasOverlayAnimation && overlayDuration > 0
          ? `min(max((t-${overlayStart.toFixed(3)})/${Math.min(0.6, overlayDuration).toFixed(3)},0),1)`
          : "1";
      const slideOffsetX = Math.max(18, Math.round(42 * scaleX));
      const slideOffsetY = Math.max(18, Math.round(42 * scaleY));
      let ovXExpr = `${ovX}`;
      let ovYExpr = `${ovY}`;
      if (hasOverlayAnimation) {
        if (animation === "slideLeft") {
          ovXExpr = `${ovX}-${slideOffsetX}*(1-${animProgress})`;
        } else if (animation === "slideRight") {
          ovXExpr = `${ovX}+${slideOffsetX}*(1-${animProgress})`;
        } else if (animation === "slideUp") {
          ovYExpr = `${ovY}+${slideOffsetY}*(1-${animProgress})`;
        } else if (animation === "slideDown") {
          ovYExpr = `${ovY}-${slideOffsetY}*(1-${animProgress})`;
        }
      }
      // All image overlays are explicitly timed upstream, so pass through on EOF.
      const overlayExpr = `overlay=x='${ovXExpr}':y='${ovYExpr}':eof_action=pass${enableExpr}`;
      filters.push(`${lastVideo}[${tagIn}]${overlayExpr}[${tagOut}]`);
      lastVideo = `[${tagOut}]`;
      continue;
    }

    const textEntry = textByKey.get(layerKey);
    if (textEntry) {
      const { layer: tl, index: i } = textEntry;
      const tagOut = `text_out_${i}`;
      const content = escapeDrawtext(tl.content || "");
      const color = (tl.color || "#ffffff").replace("#", "0x");
      const fontSize = Math.round((tl.fontSize ?? 32) * (tl.scale ?? 1) * scaleY);
      const tx = Math.round(outW / 2 + (tl.x ?? 0) * scaleX);
      const ty = Math.round(outH / 2 + (tl.y ?? 0) * scaleY);
      const opacity = ((tl.opacity ?? 100) / 100).toFixed(2);
      const bold = tl.fontWeight === "700" || tl.fontWeight === "800";
      const italic = !!tl.italic;
      let fontSuffix = "";
      if (bold && italic) fontSuffix = "-BoldOblique";
      else if (bold) fontSuffix = "-Bold";
      else if (italic) fontSuffix = "-Oblique";

      let xExpr = `${tx}`;
      if (tl.align === "center") xExpr = `${tx}-text_w/2`;
      else if (tl.align === "right") xExpr = `${tx}-text_w`;

      const hasTimeRange = typeof tl.startTime === "number" && typeof tl.endTime === "number";
      const enableExpr = hasTimeRange
        ? `:enable='between(t,${tl.startTime!.toFixed(3)},${tl.endTime!.toFixed(3)})'`
        : "";

      const hasStroke = (tl.strokeWidth ?? 0) > 0 && tl.stroke;
      const borderExpr = hasStroke
        ? `:bordercolor=${(tl.stroke as string).replace("#", "0x")}:borderw=${Math.round((tl.strokeWidth as number) * scaleY)}`
        : "";

      filters.push(
        `${lastVideo}drawtext=` +
        `text='${content}':` +
        `fontcolor=${color}@${opacity}:` +
        `fontsize=${fontSize}:` +
        `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans${fontSuffix}.ttf:` +
        `x=${xExpr}:y=${ty}-text_h/2` +
        borderExpr +
        enableExpr +
        `[${tagOut}]`
      );
      lastVideo = `[${tagOut}]`;
      continue;
    }

    const shapeEntry = shapeByKey.get(layerKey);
    if (shapeEntry) {
      const { layer: sl, index: i } = shapeEntry;
      const sw = Math.round((sl.width ?? 100) * scaleX);
      const sh =
        sl.kind === "line"
          ? Math.round((sl.strokeWidth ?? 2) * scaleY)
          : Math.round((sl.height ?? 100) * scaleY);
      const sx = Math.round(outW / 2 + (sl.x ?? 0) * scaleX - sw / 2);
      const sy = Math.round(outH / 2 + (sl.y ?? 0) * scaleY - sh / 2);
      const opacity = ((sl.opacity ?? 100) / 100).toFixed(2);
      const hasFill = sl.fill && sl.fill !== "none";
      const hasStroke = sl.stroke && sl.stroke !== "none" && (sl.strokeWidth ?? 0) > 0;
      const hasTimeRange = typeof sl.startTime === "number" && typeof sl.endTime === "number";
      const enableExpr = hasTimeRange
        ? `:enable='between(t,${sl.startTime!.toFixed(3)},${sl.endTime!.toFixed(3)})'`
        : "";

      if (hasFill) {
        const fillColor = (sl.fill as string).replace("#", "0x");
        const fillAlpha = (((sl.fillOpacity ?? 100) / 100) * parseFloat(opacity)).toFixed(2);
        const tag = `shape_fill_${i}`;
        filters.push(`${lastVideo}drawbox=x=${sx}:y=${sy}:w=${sw}:h=${sh}:color=${fillColor}@${fillAlpha}:t=fill${enableExpr}[${tag}]`);
        lastVideo = `[${tag}]`;
      }
      if (hasStroke) {
        const strokeColor = (sl.stroke as string).replace("#", "0x");
        const strokeW = Math.max(1, Math.round((sl.strokeWidth ?? 1) * Math.min(scaleX, scaleY)));
        const tag = `shape_stroke_${i}`;
        filters.push(`${lastVideo}drawbox=x=${sx}:y=${sy}:w=${sw}:h=${sh}:color=${strokeColor}@${opacity}:t=${strokeW}${enableExpr}[${tag}]`);
        lastVideo = `[${tag}]`;
      }
    }
  }

  // ── Final output tag ──────────────────────────────────────────────────────
  // Rename last tag to [vout] if it doesn't already have a proper name
  if (lastVideo !== "[vout]") {
    filters.push(`${lastVideo}copy[vout]`);
  }

  // ── Audio: trim to scene window if seeking ────────────────────────────────
  let audioMap: string;
  if (avatarSeek > 0) {
    filters.push(
      `[${avatarIdx}:a]atrim=start=${avatarSeek.toFixed(3)}:duration=${dur},asetpts=PTS-STARTPTS[av_audio]`
    );
    audioMap = `-map "[av_audio]"`;
  } else {
    audioMap = `-map ${avatarIdx}:a?`;
  }

  // ── Assemble ffmpeg command ───────────────────────────────────────────────
  const inputArgs = inputs.map(p => `-i "${p}"`).join(" ");
  const filterStr = filters.join(";");

  const cmd = [
    "ffmpeg -y",
    inputArgs,
    `-filter_complex "${filterStr}"`,
    `-map "[vout]"`,
    audioMap,
    `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p`,
    `-c:a aac -b:a 192k -ar 44100`,
    `-t ${dur}`,
    `"${outPath}"`,
  ].join(" ");

  console.info(`[composeScene ${sceneIdx}] dur=${dur}s overlays=${visibleOverlays.length} cmd:\n${cmd}`);
  await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
}

// ─── Concatenate scenes ───────────────────────────────────────────────────────

async function concatenateScenes(
  scenePaths: string[],
  outPath: string,
  workDir: string,
): Promise<void> {
  if (scenePaths.length === 1) {
    fs.copyFileSync(scenePaths[0], outPath);
    return;
  }

  const listFile = path.join(workDir, "concat_list.txt");
  fs.writeFileSync(listFile, scenePaths.map(p => `file '${p}'`).join("\n"));

  const cmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outPath}"`;
  await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
}

// ─── Mix music ────────────────────────────────────────────────────────────────

async function mixMusic(
  videoPath: string,
  outPath: string,
  workDir: string,
  musicUrl: string,
  volume: number,
  fadeOut: boolean,
  totalDur: number,
): Promise<void> {
  const musicPath = path.join(workDir, "music.mp3");
  await downloadFile(musicUrl, musicPath);

  const vol = volume.toFixed(2);
  const fadeFilter = fadeOut ? `,afade=t=out:st=${Math.max(0, totalDur - 3)}:d=3` : "";

  const cmd = [
    "ffmpeg -y",
    `-i "${videoPath}"`,
    `-i "${musicPath}"`,
    `-filter_complex`,
    `"[0:a]anull[va];[1:a]volume=${vol}${fadeFilter}[ma];[va][ma]amix=inputs=2:duration=first:dropout_transition=2[a]"`,
    `-map 0:v`,
    `-map "[a]"`,
    `-c:v copy`,
    `-c:a aac -b:a 128k`,
    `-t ${totalDur}`,
    `"${outPath}"`,
  ].join(" ");

  await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
}

// ─── Apply video transitions (xfade) ─────────────────────────────────────────
// Maps SceneTransition kind to ffmpeg xfade transition names
const XFADE_MAP: Record<string, string> = {
  fade:       "fade",
  dissolve:   "dissolve",
  zoom:       "zoomin",
  slideLeft:  "slideleft",
  slideRight: "slideright",
  slideUp:    "slideup",
  slideDown:  "slidedown",
};

async function applyTransitions(
  inputVideo: string,
  transitions: VideoTransition[],
  outPath: string,
): Promise<void> {
  if (transitions.length === 0) {
    fs.copyFileSync(inputVideo, outPath);
    return;
  }

  const sorted = [...transitions].sort((a, b) => a.time - b.time);
  const N = sorted.length + 1; // number of segments

  const filters: string[] = [];

  // Split input into N copies for video and audio
  const vsplit = Array.from({ length: N }, (_, k) => `vsplit${k}`);
  const asplit = Array.from({ length: N }, (_, k) => `asplit${k}`);
  filters.push(`[0:v]split=${N}${vsplit.map(t => `[${t}]`).join("")}`);
  filters.push(`[0:a]asplit=${N}${asplit.map(t => `[${t}]`).join("")}`);

  // Trim each segment from the hard cut boundaries.
  // xfade blends the tail of segment k with the head of segment k+1,
  // so the next segment must start at the cut itself, not at cut-duration.
  for (let k = 0; k < N; k++) {
    const start = k === 0 ? 0 : Math.max(0, sorted[k - 1].time);
    const end   = k < N - 1 ? sorted[k].time : undefined;
    const vEnd  = end !== undefined ? `:end=${end.toFixed(3)}` : "";
    const aEnd  = end !== undefined ? `:end=${end.toFixed(3)}` : "";
    filters.push(`[${vsplit[k]}]trim=start=${start.toFixed(3)}${vEnd},setpts=PTS-STARTPTS[vs${k}]`);
    filters.push(`[${asplit[k]}]atrim=start=${start.toFixed(3)}${aEnd},asetpts=PTS-STARTPTS[as${k}]`);
  }

  // Chain xfade (video) and acrossfade (audio)
  let lastV = "[vs0]";
  let lastA = "[as0]";
  for (let k = 0; k < sorted.length; k++) {
    const t      = sorted[k];
    const xtype  = XFADE_MAP[t.kind] ?? "fade";
    const dur    = Math.max(0.1, t.duration);
    const offset = Math.max(0.001, t.time - dur);
    const isLast = k === sorted.length - 1;
    const tagV   = isLast ? "[vout]" : `[xv${k}]`;
    const tagA   = isLast ? "[aout]" : `[xa${k}]`;

    filters.push(`${lastV}[vs${k + 1}]xfade=transition=${xtype}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}${tagV}`);
    filters.push(`${lastA}[as${k + 1}]acrossfade=d=${dur.toFixed(3)}${tagA}`);

    lastV = tagV;
    lastA = tagA;
  }

  const cmd = [
    "ffmpeg -y",
    `-i "${inputVideo}"`,
    `-filter_complex "${filters.join(";")}"`,
    `-map "[vout]" -map "[aout]"`,
    `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p`,
    `-c:a aac -b:a 192k -ar 44100`,
    `"${outPath}"`,
  ].join(" ");

  await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
}

// ─── Main compose function ────────────────────────────────────────────────────

export async function compose(req: ComposeRequest): Promise<string> {
  const workDir = tmpDir();
  try {
    const res = RESOLUTIONS[req.resolution ?? "1080p"];
    const refW = req.referenceWidth ?? DEFAULT_REF_W;
    const refH = req.referenceHeight ?? DEFAULT_REF_H;
    const totalDur = req.scenes.reduce((s, sc) => s + sc.durationSeconds, 0);

    // Compose each scene
    const scenePaths: string[] = [];
    for (let i = 0; i < req.scenes.length; i++) {
      const scPath = path.join(workDir, `scene_${i}.mp4`);
      await composeScene(req.scenes[i], scPath, workDir, res.w, res.h, refW, refH, i);
      scenePaths.push(scPath);
    }

    // Concatenate
    const concatPath = path.join(workDir, "concat.mp4");
    await concatenateScenes(scenePaths, concatPath, workDir);

    // Apply scene transitions (xfade) if any
    let transPath = concatPath;
    const transitions = (req.videoTransitions ?? []).filter(t => t.time > 0 && t.duration > 0);
    if (transitions.length > 0) {
      transPath = path.join(workDir, "with_transitions.mp4");
      await applyTransitions(concatPath, transitions, transPath);
    }

    // Add music if provided
    let finalPath = transPath;
    if (req.musicTrackUrl) {
      finalPath = path.join(workDir, "final.mp4");
      await mixMusic(
        transPath,
        finalPath,
        workDir,
        req.musicTrackUrl,
        req.musicVolume ?? 0.3,
        req.musicFadeOut ?? false,
        totalDur,
      );
    }

    return finalPath;
  } catch (err) {
    // Clean up on error
    fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}

export function cleanupWorkDir(videoPath: string): void {
  // workDir is the parent of the video file
  const workDir = path.dirname(videoPath);
  fs.rmSync(workDir, { recursive: true, force: true });
}

// ─── Scene boundary detection via audio silence ───────────────────────────────

/**
 * Downloads the HeyGen video and runs ffmpeg silencedetect to find audio gaps
 * between scenes. Returns N-1 boundary timestamps (seconds) for N scenes.
 * Picks the largest silence gaps as scene cut points.
 */
export async function detectSceneBoundaries(videoUrl: string, sceneCount: number): Promise<number[]> {
  if (sceneCount <= 1) return [];

  const workDir = tmpDir();
  const videoPath = path.join(workDir, "probe.mp4");

  try {
    await downloadFile(videoUrl, videoPath);

    // ffmpeg silencedetect writes results to stderr
    const cmd = `ffmpeg -i "${videoPath}" -af "silencedetect=n=-40dB:d=0.1" -f null - 2>&1`;
    let output = "";
    try {
      const result = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
      output = result.stdout + result.stderr;
    } catch (e: any) {
      // ffmpeg exits non-zero when piping to null on some versions — still capture output
      output = (e.stdout ?? "") + (e.stderr ?? "");
    }

    const startMatches = [...output.matchAll(/silence_start: ([\d.]+)/g)];
    const endMatches = [...output.matchAll(/silence_end: ([\d.]+)/g)];

    const gaps: Array<{ start: number; end: number; duration: number }> = [];
    for (let i = 0; i < Math.min(startMatches.length, endMatches.length); i++) {
      const start = parseFloat(startMatches[i]![1]!);
      const end = parseFloat(endMatches[i]![1]!);
      if (end > start) {
        gaps.push({ start, end, duration: end - start });
      }
    }

    console.info(`[detectSceneBoundaries] sceneCount=${sceneCount} gaps found:`, gaps);

    if (gaps.length === 0) return [];

    // Pick the N-1 largest silence gaps, sorted by their position in the video
    const needed = sceneCount - 1;
    const selected = [...gaps]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, needed)
      .sort((a, b) => a.start - b.start);

    // Return midpoint of each selected gap as the scene boundary
    const boundaries = selected.map((g) => (g.start + g.end) / 2);
    console.info(`[detectSceneBoundaries] boundaries:`, boundaries);
    return boundaries;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
