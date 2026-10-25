// Making a profile picture small enough to send: the picture a player chooses on his device (often several megabytes) is cut to a square from the
// middle, shrunk to AVATAR_SIDE pixels and saved as a JPEG of a few kilobytes. The server checks all of this again and does not trust it.

/** The side of the picture we send, in pixels. */
export const AVATAR_SIDE = 128;
/** The picture file the player may choose, at most (before it is shrunk). */
export const MAX_PICK_BYTES = 15 * 1024 * 1024;
/** The server takes at most this many bytes (server/profile.ts AVATAR_MAX_BYTES); we stay well below. */
export const SEND_MAX_BYTES = 40 * 1024;
/** What a file input may offer. */
export const PICK_TYPES = 'image/jpeg,image/png,image/webp,image/gif';

/** The square (in source pixels) that is cut from the middle of a picture of this size. */
export function centreSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.max(1, Math.min(width, height));
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/** Why a chosen file cannot be used, or null when it can. */
export function pickProblem(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) return 'Choose a picture file (a photo or an image).';
  if (file.size > MAX_PICK_BYTES) return 'That picture is too big. Choose one under 15 MB.';
  return null;
}

/** Shrinks a picture the player chose to a small square JPEG, as "data:image/jpeg;base64,...". Throws an Error with words for the player. */
export async function shrinkPicture(file: Blob): Promise<string> {
  const problem = pickProblem({ type: file.type, size: file.size });
  if (problem) throw new Error(problem);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be opened as a picture. Try a JPEG or PNG.');
  }
  try {
    const { sx, sy, side } = centreSquare(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot shrink pictures.');
    ctx.fillStyle = '#ffffff'; // a see-through picture gets a white background (a JPEG has no see-through)
    ctx.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE);
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    for (const quality of [0.85, 0.7, 0.5, 0.35]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      // base64 is a third bigger than the bytes
      if (Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4) <= SEND_MAX_BYTES) return url;
    }
    throw new Error('That picture could not be made small enough. Try another one.');
  } finally {
    bitmap.close();
  }
}
