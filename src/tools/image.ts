/** Marker for image tool results: IMAGE_PREFIX<mime>:<base64>. */
export const IMAGE_PREFIX = '@@ILIDES_IMAGE@@';

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function parseImageResult(result: string): { mime: string; b64: string } | null {
  if (!result.startsWith(IMAGE_PREFIX)) return null;
  const rest = result.slice(IMAGE_PREFIX.length);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  return { mime: rest.slice(0, i), b64: rest.slice(i + 1) };
}
