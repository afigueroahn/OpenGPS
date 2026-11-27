// Pictures chosen on the phone. The person's photo: the system's own editor
// cuts it square, and it travels small, as the web app sends it
// (apps/web/src/lib/image.ts): 256 pixels a side, as a PNG when it may have a
// transparent background and otherwise as a JPEG at 85%. A photo as evidence
// of an incident goes whole, only reduced.
import { photoTypeFor } from "@opengps/shared";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/** Pixels on each side of the photo. */
export const PHOTO_SIZE = 256;
/** Longest side of a photo sent as evidence: enough to read a document, well under the platform's 8 MB. */
export const EVIDENCE_SIDE = 2000;

export class PhotoError extends Error {
  constructor(readonly reason: "permission" | "camera") {
    super(reason);
  }
}

/** The picture the person chose or took; null if they cancel. */
async function pick(from: "library" | "camera", options: ImagePicker.ImagePickerOptions): Promise<ImagePicker.ImagePickerAsset | null> {
  let result: ImagePicker.ImagePickerResult;
  if (from === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new PhotoError("permission");
    try {
      result = await ImagePicker.launchCameraAsync(options);
    } catch {
      // A phone without a camera, or the simulator.
      throw new PhotoError("camera");
    }
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options);
  }
  return result.canceled ? null : (result.assets[0] ?? null);
}

/** A photo from the library or the camera, cut square and small, with its type. null if the person cancels. */
export async function pickPhoto(from: "library" | "camera"): Promise<{ data: Blob; type: "image/png" | "image/jpeg" } | null> {
  const asset = await pick(from, { mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
  if (!asset) return null;
  // The editor already cuts it square; the middle square is taken anyway, so it never comes out stretched.
  const side = Math.min(asset.width, asset.height);
  const image = await ImageManipulator.manipulate(asset.uri)
    .crop({ originX: (asset.width - side) / 2, originY: (asset.height - side) / 2, width: side, height: side })
    .resize({ width: PHOTO_SIZE, height: PHOTO_SIZE })
    .renderAsync();
  // The editor gives a PNG back as a PNG, and the rest, the camera's photos too, as JPEG.
  const type = photoTypeFor(asset.mimeType ?? "image/jpeg");
  const saved = await image.saveAsync(type === "image/png" ? { format: SaveFormat.PNG } : { format: SaveFormat.JPEG, compress: 0.85 });
  return { data: await (await fetch(saved.uri)).blob(), type };
}

/** A photo from the library or the camera, whole, as evidence of an incident. null if the person cancels. */
export async function pickEvidence(from: "library" | "camera"): Promise<Blob | null> {
  const asset = await pick(from, { mediaTypes: ["images"], allowsEditing: false, quality: 1 });
  if (!asset) return null;
  const scale = Math.min(1, EVIDENCE_SIDE / Math.max(asset.width, asset.height));
  const image = await ImageManipulator.manipulate(asset.uri)
    .resize({ width: Math.round(asset.width * scale), height: Math.round(asset.height * scale) })
    .renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  return await (await fetch(saved.uri)).blob();
}
