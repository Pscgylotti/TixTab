/** PNG data URL of a canvas, encoded off the input task. `toDataURL` compresses
 * synchronously, which blocks the window for a large formula or sketch raster. */
export async function canvasPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(Error('png-encode'))), 'image/png'),
  );
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(Error('png-encode'));
    reader.onerror = reader.onabort = () => reject(Error('png-encode'));
    reader.readAsDataURL(blob);
  });
}
