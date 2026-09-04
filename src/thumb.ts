/** The long-form thumbnail: any picture the user picked, as a JPEG at
 *  YouTube's own thumbnail size.
 *
 *  Rasterised in the browser for the same reason `renderTitleArt` is — the
 *  server hands the bytes to ffmpeg or writes them to disk and never has to
 *  understand an image format. Here that buys more than it does there: the
 *  browser decodes every format it can display (jpeg, png, webp, avif, gif),
 *  which is a wider set than a scale filter would have to be told about, and
 *  the output is exactly 1280x720 so nothing server-side has to check.
 *
 *  DOM-driven and untested, like `starter.ts` and the rest of this layer. */

/** YouTube's thumbnail size, and not a knob: it is the shape every 16:9
 *  surface (search, embeds, suggested video) renders. */
export const THUMB = { w: 1280, h: 720 };

/** Enough headroom to stay under YouTube's own 2 MB thumbnail limit at
 *  1280x720 with room to spare, without visible ringing on a photo. */
const QUALITY = 0.92;

/** `file` stretched to 1280x720 as bare base64 JPEG (no `data:` prefix).
 *
 *  STRETCHED, deliberately: `drawImage` is given the whole destination
 *  rectangle, so a portrait or square picture is distorted to fill the frame
 *  rather than being cropped or letterboxed. That is what was asked for —
 *  the user picks the picture knowing the shape it has to become, and a crop
 *  would silently throw away whatever they had put at the edges.
 *
 *  Throws if the file is not a picture this browser can decode, which is the
 *  only validation this side needs: the message names the file. */
export async function renderThumb(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} is not a picture this browser can read.`);
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB.w;
    canvas.height = THUMB.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, THUMB.w, THUMB.h);
    // The server takes bare base64 and checks the JPEG signature itself, so
    // the "data:image/jpeg;base64," preamble is dropped here rather than
    // parsed there — the same split `renderTitleArt` does.
    return canvas.toDataURL("image/jpeg", QUALITY).split(",")[1] ?? "";
  } finally {
    // An ImageBitmap holds decoded pixels off-heap until it is closed, and a
    // user auditioning several pictures would otherwise leak one full-size
    // decode per attempt.
    bitmap.close();
  }
}
