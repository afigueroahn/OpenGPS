// Images cut in the browser before they are sent, so they travel small.

/**
 * A square from the middle of the picture, `size` pixels on each side, as a JPEG. Used for the person's photo.
 * Returns null if the browser cannot read the file as an image.
 */
export async function squarePhoto(file: File, size = 256): Promise<Blob | null> {
  try {
    // The phone's rotation comes with the picture: it is applied before cutting.
    const image = await createImageBitmap(file, { imageOrientation: "from-image" });
    const side = Math.min(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // A transparent PNG would turn black as a JPEG: it gets a white background.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size, size);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
    image.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  } catch {
    return null;
  }
}
