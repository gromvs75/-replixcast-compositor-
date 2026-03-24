import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as http from "http";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";
import type { SceneInput, ComposeRequest } from "./types";

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
  const overlayPaths: string[] = [];

  // Download visible overlay layers
  const visibleOverlays = (scene.overlayLayers || []).filter(l => l.visible !== false && l.url);
  for (const ov of visibleOverlays) {
    const ext = ov.kind === "video" ? ".mp4" : ".png";
    const p = path.join(workDir, `overlay_${sceneIdx}_${ov.id}${ext}`);
    await downloadFile(ov.url, p);
    inputs.push(p);
    overlayPaths.push(p);
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

  const dur = scene.durationSeconds;

  // ── Build filter_complex ───────────────────────────────────────────────────

  let inputIdx = 0;
  const filters: string[] = [];
  let lastVideo = "";

  // ── Background ────────────────────────────────────────────────────────────
  const bgOpacity = ((scene.backgroundOpacity ?? 100) / 100).toFixed(2);
  const bpx = (scene.backgroundParams?.x ?? 0) * scaleX;
  const bpy = (scene.backgroundParams?.y ?? 0) * scaleY;
  const bpScale = scene.backgroundParams?.scale ?? 1;

  if (scene.backgroundVisible === false) {
    // No background — black canvas
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
      // geq gradient filter
      const rExpr = `${c1.r}+(${c2.r - c1.r})*((X*${Math.sin(angleRad).toFixed(4)}+Y*${Math.cos(angleRad).toFixed(4)})/(W*${Math.sin(angleRad).toFixed(4)}+H*${Math.cos(angleRad).toFixed(4)}))`;
      const gExpr = `${c1.g}+(${c2.g - c1.g})*((X*${Math.sin(angleRad).toFixed(4)}+Y*${Math.cos(angleRad).toFixed(4)})/(W*${Math.sin(angleRad).toFixed(4)}+H*${Math.cos(angleRad).toFixed(4)}))`;
      const bExpr = `${c1.b}+(${c2.b - c1.b})*((X*${Math.sin(angleRad).toFixed(4)}+Y*${Math.cos(angleRad).toFixed(4)})/(W*${Math.sin(angleRad).toFixed(4)}+H*${Math.cos(angleRad).toFixed(4)}))`;
      filters.push(`color=s=${outW}x${outH}:d=${dur}[bgbase];[bgbase]geq=r='${rExpr}':g='${gExpr}':b='${bExpr}'[bg]`);
    } else {
      // Fallback: extract first color
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

  if (scene.avatarVisible !== false) {
    // Scale avatar to fill height, then apply user scale
    const avatarH = Math.round(outH * aScale);
    filters.push(
      `[${avatarIdx}:v]scale=-2:${avatarH},` +
      `setpts=PTS-STARTPTS,trim=duration=${dur}[av_scaled]`
    );
    // Position: centered by default (x=0,y=0 means center), offset by ax/ay
    filters.push(
      `${lastVideo}[av_scaled]overlay=` +
      `x=(main_w-overlay_w)/2+${Math.round(ax)}:` +
      `y=(main_h-overlay_h)/2+${Math.round(ay)}` +
      `[av_out]`
    );
    lastVideo = "[av_out]";
  }

  // ── Overlay layers ────────────────────────────────────────────────────────
  for (let i = 0; i < visibleOverlays.length; i++) {
    const ov = visibleOverlays[i];
    const ovIdx = inputIdx++;
    const ovX = Math.round((ov.x ?? 0) * scaleX);
    const ovY = Math.round((ov.y ?? 0) * scaleY);
    const ovScale = ov.scale ?? 1;
    const ovOpacity = ((ov.opacity ?? 100) / 100).toFixed(2);
    const tagIn = `ov_raw_${i}`;
    const tagOut = `ov_out_${i}`;

    if (ov.kind === "video") {
      filters.push(
        `[${ovIdx}:v]scale=iw*${ovScale}:-2,setpts=PTS-STARTPTS,trim=duration=${dur},` +
        `loop=loop=-1:size=32767:start=0[${tagIn}]`
      );
    } else {
      filters.push(`[${ovIdx}:v]scale=iw*${ovScale}:-2,format=rgba,colorchannelmixer=aa=${ovOpacity}[${tagIn}]`);
    }
    filters.push(`${lastVideo}[${tagIn}]overlay=x=${ovX}:y=${ovY}[${tagOut}]`);
    lastVideo = `[${tagOut}]`;
  }

  // ── Text layers ───────────────────────────────────────────────────────────
  const visibleText = (scene.textLayers || []).filter(l => l.visible !== false && l.content?.trim());
  for (let i = 0; i < visibleText.length; i++) {
    const tl = visibleText[i];
    const tagOut = `text_out_${i}`;
    const content = escapeDrawtext(tl.content || "");
    const color = (tl.color || "#ffffff").replace("#", "0x");
    const fontSize = Math.round((tl.fontSize ?? 32) * (tl.scale ?? 1) * scaleY);
    const fontFamily = tl.fontFamily || "Sans";
    // x/y: offset from canvas center
    const tx = Math.round(outW / 2 + (tl.x ?? 0) * scaleX);
    const ty = Math.round(outH / 2 + (tl.y ?? 0) * scaleY);
    const opacity = ((tl.opacity ?? 100) / 100).toFixed(2);
    const bold = (tl.fontWeight === "700" || tl.fontWeight === "800");
    const italic = !!tl.italic;
    // ffmpeg drawtext has no italic= param — select the correct font variant instead
    let fontSuffix = "";
    if (bold && italic) fontSuffix = "-BoldOblique";
    else if (bold) fontSuffix = "-Bold";
    else if (italic) fontSuffix = "-Oblique";

    let xExpr = `${tx}`;
    if (tl.align === "center") xExpr = `${tx}-text_w/2`;
    else if (tl.align === "right") xExpr = `${tx}-text_w`;

    const hasTimeRange = typeof tl.startTime === "number" && typeof tl.endTime === "number";
    const enableExpr = hasTimeRange ? `:enable='between(t,${(tl.startTime as number).toFixed(3)},${(tl.endTime as number).toFixed(3)})'` : "";

    filters.push(
      `${lastVideo}drawtext=` +
      `text='${content}':` +
      `fontcolor=${color}@${opacity}:` +
      `fontsize=${fontSize}:` +
      `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans${fontSuffix}.ttf:` +
      `x=${xExpr}:y=${ty}-text_h/2` +
      enableExpr +
      `[${tagOut}]`
    );
    lastVideo = `[${tagOut}]`;
  }

  // ── Final output tag ──────────────────────────────────────────────────────
  // Rename last tag to [vout] if it doesn't already have a proper name
  if (lastVideo !== "[vout]") {
    filters.push(`${lastVideo}copy[vout]`);
  }

  // ── Assemble ffmpeg command ───────────────────────────────────────────────
  const inputArgs = inputs.map(p => `-i "${p}"`).join(" ");
  const filterStr = filters.join(";");

  const cmd = [
    "ffmpeg -y",
    inputArgs,
    `-filter_complex "${filterStr}"`,
    `-map "[vout]"`,
    `-map ${avatarIdx}:a?`,   // avatar TTS audio if present
    `-c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p`,
    `-c:a aac -b:a 128k -ar 44100`,
    `-t ${dur}`,
    `"${outPath}"`,
  ].join(" ");

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

    // Add music if provided
    let finalPath = concatPath;
    if (req.musicTrackUrl) {
      finalPath = path.join(workDir, "final.mp4");
      await mixMusic(
        concatPath,
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
