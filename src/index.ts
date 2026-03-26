import express from "express";
import { compose, cleanupWorkDir, detectSceneBoundaries } from "./compositor";
import { uploadToFirebase } from "./firebase";
import type { ComposeRequest, ComposeResponse } from "./types";

const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = parseInt(process.env.PORT || "3000", 10);
const SECRET = process.env.COMPOSITOR_SECRET;

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Compose endpoint ─────────────────────────────────────────────────────────

app.post("/compose", async (req, res) => {
  const t0 = Date.now();
  const body = req.body as ComposeRequest;

  // Auth
  console.log(`[auth] received="${String(body.secret||"").slice(0,8)}" env="${String(SECRET||"").slice(0,8)}" match=${body.secret===SECRET}`);
  if (SECRET && body.secret !== SECRET) {
    res.status(401).json({ status: "error", error: "Unauthorized" } satisfies ComposeResponse);
    return;
  }

  // Validate
  if (!body.projectId || !Array.isArray(body.scenes) || body.scenes.length === 0) {
    res.status(400).json({ status: "error", error: "projectId and scenes[] are required" } satisfies ComposeResponse);
    return;
  }

  for (const sc of body.scenes) {
    if (!sc.avatarVideoUrl || !sc.durationSeconds) {
      res.status(400).json({ status: "error", error: "Each scene must have avatarVideoUrl and durationSeconds" } satisfies ComposeResponse);
      return;
    }
  }

  console.log(`[compose] projectId=${body.projectId} scenes=${body.scenes.length} resolution=${body.resolution ?? "1080p"} musicTrackUrl=${body.musicTrackUrl || "null"} overlays=${body.scenes[0]?.overlayLayers?.length ?? 0}`);

  let videoPath: string | null = null;
  try {
    videoPath = await compose(body);

    // Upload to Firebase Storage
    const destPath = `compositor/${body.projectId}/${Date.now()}.mp4`;
    const uploadT0 = Date.now();
    const videoUrl = await uploadToFirebase(videoPath, destPath);
    console.log(`[compose] uploadMs=${Date.now() - uploadT0}`);

    const durationMs = Date.now() - t0;
    console.log(`[compose] done in ${durationMs}ms → ${videoUrl}`);

    res.json({
      status: "ok",
      videoUrl,
      durationMs,
    } satisfies ComposeResponse);
  } catch (err: any) {
    console.error("[compose] error:", err?.message ?? err);
    res.status(500).json({
      status: "error",
      error: err?.message ?? "Compositing failed",
    } satisfies ComposeResponse);
  } finally {
    if (videoPath) cleanupWorkDir(videoPath);
  }
});

// ─── Detect scene boundaries ──────────────────────────────────────────────────

app.post("/detect-scene-boundaries", async (req, res) => {
  const { videoUrl, sceneCount, secret } = req.body ?? {};

  if (SECRET && secret !== SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  if (!videoUrl || typeof sceneCount !== "number" || sceneCount < 2) {
    res.status(400).json({ ok: false, error: "videoUrl and sceneCount >= 2 are required" });
    return;
  }

  try {
    const boundaries = await detectSceneBoundaries(String(videoUrl), sceneCount);
    console.log(`[detect-scene-boundaries] sceneCount=${sceneCount} boundaries=${JSON.stringify(boundaries)}`);
    res.json({ ok: true, boundaries });
  } catch (err: any) {
    console.error("[detect-scene-boundaries] error:", err?.message);
    res.status(500).json({ ok: false, error: err?.message ?? "Detection failed" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🎬 Compositor listening on port ${PORT}`);
});
