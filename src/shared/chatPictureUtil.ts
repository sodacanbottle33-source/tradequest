// Making a picture small enough to send in a chat: the photo a player chooses on his device (often several megabytes) is shrunk so that its longest side is
// at most CHAT_PIC_SIDE pixels and saved as a JPEG of a few dozen kilobytes. The server checks all of this again and does not trust it (server/chatPictures.ts).

/** The most pixels on a side that the server takes (server/chatPictures.ts CHAT_PIC_MAX_SIDE). */
export const CHAT_PIC_SIDE = 800;
/** The server takes at most 90 KB; we stay below it. */
export const CHAT_SEND_MAX_BYTES = 80 * 1024;
/** The picture file a player may choose, at most (before it is shrunk). */
export const CHAT_PICK_MAX_BYTES = 20 * 1024 * 1024;
/** What a file input may offer. */
export const CHAT_PICK_TYPES = 'image/jpeg,image/png,image/webp,image/gif';
/** The sizes and qualities we try, from the nicest to the smallest, until the picture is small enough. */
export const SHRINK_SIDES: readonly number[] = [CHAT_PIC_SIDE, 640, 480, 360, 240];
export const SHRINK_QUALITIES: readonly number[] = [0.82, 0.68, 0.52, 0.38];

/** The size a picture gets when its longest side may be at most `max` pixels. A smaller picture keeps its size. */
export function fitSize(width: number, height: number, max: number): { width: number; height: number } {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** How many bytes the picture inside a "data:...;base64,..." address has. */
export function dataUrlBytes(url: string): number {
  const at = url.indexOf(',');
  if (at < 0) return 0;
  const body = url.slice(at + 1);
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/** Why a chosen file cannot be used, or null when it can. */
export function chatPickProblem(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) return 'Choose a picture file (a photo or an image).';
  if (file.size > CHAT_PICK_MAX_BYTES) return 'That picture is too big. Choose one under 20 MB.';
  return null;
}

/** Shrinks a chosen picture to a JPEG small enough to send, as "data:image/jpeg;base64,...". Throws an Error with words for the player. */
export async function shrinkChatPicture(file: Blob): Promise<string> {
  const problem = chatPickProblem({ type: file.type, size: file.size });
  if (problem) throw new Error(problem);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be opened as a picture. Try a JPEG or PNG.');
  }
  try {
    for (const side of SHRINK_SIDES) {
      const size = fitSize(bitmap.width, bitmap.height, side);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser cannot shrink pictures.');
      ctx.fillStyle = '#ffffff'; // a see-through picture gets a white background (a JPEG has no see-through)
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      for (const quality of SHRINK_QUALITIES) {
        const url = canvas.toDataURL('image/jpeg', quality);
        if (dataUrlBytes(url) <= CHAT_SEND_MAX_BYTES) return url;
      }
    }
    throw new Error('That picture could not be made small enough. Try another one.');
  } finally {
    bitmap.close();
  }
}
