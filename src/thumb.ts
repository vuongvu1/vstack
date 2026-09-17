/** Rasterising a picked picture for a server that cannot: the long-form
 *  thumbnail and the lofi background.
 *
 *  Rasterised in the browser for the same reason `renderTitleArt` is — the
 *  server hands the bytes to ffmpeg or writes them to disk and never has to
 *  understand an image format. Here that buys more than it does there: the
 *  browser decodes every format it can display (jpeg, png, webp, avif, gif),
 *  which is a wider set than a scale filter would have to be told about, and
 *  the output is exactly the caller's own fixed size so nothing server-side
 *  has to check a dimension.
 *
 *  DOM-driven and untested, like `starter.ts` and the rest of this layer. */

/** YouTube's thumbnail size, and not a knob: it is the shape every 16:9
 *  surface (search, embeds, suggested video) renders. */
export const THUMB = { w: 1280, h: 720 };

/** The lofi background: the render's own 1920x1080 base video. */
export const WIDE_IMAGE = { w: 1920, h: 1080 };

/** Enough headroom to stay under YouTube's own 2 MB thumbnail limit at
 *  1280x720 with room to spare, without visible ringing on a photo. */
const QUALITY = 0.92;

/** Decodes `file` into an `ImageBitmap`, or throws with a message naming the
 *  file — the only validation either rasteriser needs client-side. Shared
 *  because it is genuinely the same step for both jobs; what each does with
 *  the decoded bitmap is not. */
async function decodeBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} is not a picture this browser can read.`);
  }
}

/** `canvas` encoded as bare base64 JPEG (no `data:` prefix).
 *
 *  The server takes bare base64 and checks the JPEG signature itself, so the
 *  "data:image/jpeg;base64," preamble is dropped here rather than parsed
 *  there — the same split `renderTitleArt` does. */
function encodeJpeg(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", QUALITY).split(",")[1] ?? "";
}

/** `file` stretched to 1280x720 as bare base64 JPEG — the publish thumbnail.
 *
 *  STRETCHED, deliberately: `drawImage` is given the whole destination
 *  rectangle, so a portrait or square picture is distorted to fill the frame
 *  rather than being cropped or letterboxed. That is what was asked for —
 *  the user picks the picture for THIS slot knowing the shape it has to
 *  become, and a crop would silently discard whatever they had composed at
 *  the edges. Cover-cropping here would be the wrong rule for the right
 *  reason: it looks more "correct" in isolation but throws away exactly the
 *  framing the user picked the picture for. */
export async function renderThumb(file: File): Promise<string> {
  const bitmap = await decodeBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB.w;
    canvas.height = THUMB.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, THUMB.w, THUMB.h);
    return encodeJpeg(canvas);
  } finally {
    // An ImageBitmap holds decoded pixels off-heap until it is closed, and a
    // user auditioning several pictures would otherwise leak one full-size
    // decode per attempt.
    bitmap.close();
  }
}

/** `file` cover-cropped to 1920x1080 as bare base64 JPEG — the lofi
 *  journey's background, the render's own picture for its entire length.
 *
 *  COVER-CROPPED, deliberately, and NOT `renderThumb`'s stretch: a distorted
 *  photo here is not a thumbnail glanced at once, it is on screen behind the
 *  video for every second of the render. The source rectangle in the
 *  nine-argument `drawImage` below is scaled to cover both axes of the
 *  destination and centred, so a non-16:9 picture keeps its proportions and
 *  loses its edges instead of being squashed into the frame.
 *
 *  This is also the half of the agreement `server/lofi.ts`'s own
 *  `force_original_aspect_ratio=increase` + `crop` graph depends on: that
 *  graph cover-crops too, but only ever sees a frame that is already exactly
 *  1920x1080 because this function did the cropping first, which is what
 *  keeps it a no-op instead of a second, disagreeing crop. */
export async function renderWide(file: File): Promise<string> {
  const bitmap = await decodeBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = WIDE_IMAGE.w;
    canvas.height = WIDE_IMAGE.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    const scale = Math.max(
      WIDE_IMAGE.w / bitmap.width,
      WIDE_IMAGE.h / bitmap.height,
    );
    const sw = WIDE_IMAGE.w / scale;
    const sh = WIDE_IMAGE.h / scale;
    const sx = (bitmap.width - sw) / 2;
    const sy = (bitmap.height - sh) / 2;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, WIDE_IMAGE.w, WIDE_IMAGE.h);
    return encodeJpeg(canvas);
  } finally {
    bitmap.close();
  }
}
