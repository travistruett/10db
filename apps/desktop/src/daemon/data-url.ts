/** A picture as a data URL: the window's CSP allows images from `self` and `data:`, not from `blob:`. */
export function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // `readAsDataURL` always leaves a string.
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The picture could not be read'));
    };
    reader.onerror = () => {
      reject(new Error('The picture could not be read'));
    };
    reader.readAsDataURL(blob);
  });
}
