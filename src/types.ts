// ─── Layer types (mirrors replixcast-admin constants) ────────────────────────

export type TextLayerDraft = {
  id: string;
  content?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "400" | "500" | "600" | "700" | "800";
  align?: "left" | "center" | "right";
  x?: number;        // px offset from canvas center
  y?: number;        // px offset from canvas center
  scale?: number;    // multiplier, 1.0 = default
  opacity?: number;  // 0–100
  italic?: boolean;
  underline?: boolean;
  visible?: boolean;
  startTime?: number; // seconds — show only from this time
  endTime?: number;   // seconds — hide after this time
};

export type OverlayLayerDraft = {
  id: string;
  url: string;
  kind: "image" | "video";
  x?: number;       // px offset from canvas top-left
  y?: number;
  width?: number;
  height?: number;
  scale?: number;   // multiplier, 1.0 = natural size
  opacity?: number; // 0–100
  visible?: boolean;
  animation?: "none" | "fadeIn" | "slideUp" | "slideDown" | "slideLeft" | "slideRight" | "zoomIn" | "bounce" | "typewriter";
  startTime?: number; // seconds — show only from this time
  endTime?: number;   // seconds — hide after this time
};

export type ShapeLayerDraft = {
  id: string;
  kind: "rect" | "roundedRect" | "circle" | "line" | "triangle" | "path";
  pathData?: string;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  startTime?: number;
  endTime?: number;
};

export type MusicTrack = {
  previewURL: string;
  title?: string;
};

// ─── Scene data sent by client ───────────────────────────────────────────────

export type SceneInput = {
  avatarVideoUrl: string;           // HeyGen rendered video URL
  avatarStartTimeSeconds?: number;  // trim shared avatar/base video from this offset
  durationSeconds: number;
  backgroundType?: "color" | "gradient" | "image" | "video" | null;
  backgroundValue?: string | null;
  backgroundVisible?: boolean;
  backgroundOpacity?: number;       // 0–100, default 100
  backgroundParams?: { x?: number; y?: number; scale?: number };
  avatarVisible?: boolean;
  avatarParams?: { x?: number; y?: number; scale?: number };
  overlayLayers?: OverlayLayerDraft[];
  textLayers?: TextLayerDraft[];
  shapeLayers?: ShapeLayerDraft[];
  layerOrder?: string[];
};

// ─── Video transitions ────────────────────────────────────────────────────────

export type VideoTransition = {
  time: number;     // seconds — cut point in original video
  kind: "fade" | "dissolve" | "zoom" | "slideLeft" | "slideRight" | "slideUp" | "slideDown";
  duration: number; // seconds
};

// ─── Compose request ─────────────────────────────────────────────────────────

export type ComposeRequest = {
  projectId: string;
  scenes: SceneInput[];
  resolution?: "720p" | "1080p";
  // Reference canvas size used in the editor (for coordinate scaling)
  referenceWidth?: number;
  referenceHeight?: number;
  // Global music track applied to full video
  musicTrackUrl?: string | null;
  musicVolume?: number;  // 0–1, default 0.3
  musicTrimToVideo?: boolean;
  musicFadeOut?: boolean;
  // Scene-to-scene transitions applied after composition
  videoTransitions?: VideoTransition[];
  secret: string;
};

export type ComposeResponse = {
  status: "ok" | "error";
  videoUrl?: string;
  error?: string;
  durationMs?: number;
};
