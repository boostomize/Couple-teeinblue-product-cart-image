import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import cors from "cors";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

import { fetchAndCrop } from "./src/cropper.js";
import { validateAndNormalizeParams } from "./src/security.js";

const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(morgan("combined"));

const BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://img.boostomize.de";

const PORT = process.env.PORT || 3000;

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.R2_BUCKET;

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

/*
OLD ENDPOINT bleibt bestehen
*/
app.get("/crop", async (req, res) => {
  let params;

  try {
    params = validateAndNormalizeParams(req.query);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const { buffer, contentType, etag } = await fetchAndCrop(params);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", etag);

    return res.status(200).send(buffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to process image" });
  }
});

/*
NEU:
macht Bild + speichert + gibt feste URL zurück
*/
app.get("/make", async (req, res) => {
  let params;

  try {
    params = validateAndNormalizeParams(req.query);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const keyHash = sha1(
      `${params.src}|${params.focus}|${params.width}|${params.height}|${params.cutPercent}|${params.zoom}|${params.jpegQuality}`
    );

    const fileKey = `img/${keyHash}.jpg`;

    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: BUCKET,
          Key: fileKey
        })
      );

      return res.json({
        ok: true,
        url: `${BASE_URL}/img/${keyHash}.jpg`,
        cached: true
      });
    } catch {}

    const { buffer } = await fetchAndCrop(params);

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: fileKey,
        Body: buffer,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable"
      })
    );

    return res.json({
      ok: true,
      url: `${BASE_URL}/img/${keyHash}.jpg`,
      cached: false
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create image" });
  }
});

/*
liefert gespeichertes Bild
*/
app.get("/img/:file", async (req, res) => {
  try {
    const key = `img/${req.params.file}`;

    const file = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key
      })
    );

    const buffer = await streamToBuffer(file.Body);

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    return res.send(buffer);
  } catch (err) {
    return res.status(404).json({ error: "Not found" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
