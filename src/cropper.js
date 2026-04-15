import axios from "axios";
import crypto from "crypto";
import sharp from "sharp";

const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "8000", 10);
const MAX_IMAGE_BYTES = parseInt(process.env.MAX_IMAGE_BYTES || "15000000", 10);

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/**
 * Crop strategy:
 * - We output fixed width/height (defaults 700x700)
 * - We "zoom in" by taking a smaller crop region than original, then resizing up
 * - We shift crop window left or right to bias focus
 * - "cutPercent" controls how aggressively we bias to one side (~30% by default)
 */
export async function fetchAndCrop({ src, focus, width, height, cutPercent, zoom, jpegQuality }) {
  const key = `${src}|${focus}|${width}x${height}|cut=${cutPercent}|zoom=${zoom}|q=${jpegQuality}`;
  const etag = `"${sha1(key)}"`;

  const resp = await axios.get(src, {
    responseType: "arraybuffer",
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    validateStatus: (s) => s >= 200 && s < 300,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": "https://cdn.teeinblue.com/",
      "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
    }
  });

  const input = Buffer.from(resp.data);

  // Decode metadata
  const img = sharp(input, { failOn: "none" });
  const meta = await img.metadata();

  if (!meta.width || !meta.height) {
    throw new Error("Could not read image dimensions");
  }

  const W = meta.width;
  const H = meta.height;

  // Determine crop box that matches output aspect ratio
  const outRatio = width / height;

  // Start from a crop that fits ratio
  let cropW, cropH;

  // "cover" style crop: fit output ratio inside original
  if (W / H > outRatio) {
    // image is wider than target -> limit by height
    cropH = H;
    cropW = Math.round(H * outRatio);
  } else {
    // image is taller than target -> limit by width
    cropW = W;
    cropH = Math.round(W / outRatio);
  }

  // Apply zoom: smaller crop region => zoom in when resized
  cropW = Math.max(1, Math.round(cropW / zoom));
  cropH = Math.max(1, Math.round(cropH / zoom));

  // Compute x/y with left/right bias
  // Base center crop
  let x = Math.round((W - cropW) / 2);
  let y = Math.round((H - cropH) / 2);

  // Bias horizontally: cutPercent controls shift magnitude
  // If focus=left: shift window to left (smaller x)
  // If focus=right: shift window to right (larger x)
  const maxShift = Math.round((W - cropW) * cutPercent);

  if (focus === "left") {
    x = Math.max(0, x - maxShift);
  } else if (focus === "right") {
    x = Math.min(W - cropW, x + maxShift);
  }

  // Clamp
  x = Math.max(0, Math.min(x, W - cropW));
  y = Math.max(0, Math.min(y, H - cropH));

  const outBuffer = await sharp(input, { failOn: "none" })
    .extract({ left: x, top: y, width: cropW, height: cropH })
    .resize(width, height, { fit: "cover" })
    .jpeg({ quality: jpegQuality, mozjpeg: true })
    .toBuffer();

  return {
    buffer: outBuffer,
    contentType: "image/jpeg",
    etag
  };
}
