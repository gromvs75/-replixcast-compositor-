import express from "express";
import { compose, cleanupWorkDir } from "./compositor";
import { uploadToFirebase } from "./firebase";
import type { ComposeRequest, ComposeResponse } from "./types";

const app = express();
app.use(express.json({ limit: "2mb" }));

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

  console.log(`[compose] projectId=${body.projectId} scenes=${body.scenes.length} resolution=${body.resolution ?? "1080p"}`);

  let videoPath: string | null = null;
  try {
    videoPath = await compose(body);

    // Upload to Firebase Storage
    const destPath = `compositor/${body.projectId}/${Date.now()}.mp4`;
    const videoUrl = await uploadToFirebase(videoPath, destPath);

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

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🎬 Compositor listening on port ${PORT}`);
});
