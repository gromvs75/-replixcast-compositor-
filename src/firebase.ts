import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";

let initialized = false;

function initFirebase() {
  if (initialized) return;
  const serviceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64;
  if (!serviceAccountB64) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_B64 env var is missing");
  const serviceAccount = JSON.parse(Buffer.from(serviceAccountB64, "base64").toString("utf-8"));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  initialized = true;
}

export async function uploadToFirebase(
  localPath: string,
  destPath: string,
): Promise<string> {
  initFirebase();
  const bucket = admin.storage().bucket();
  await bucket.upload(localPath, {
    destination: destPath,
    metadata: { contentType: "video/mp4" },
  });
  const file = bucket.file(destPath);
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
  });
  return url;
}
