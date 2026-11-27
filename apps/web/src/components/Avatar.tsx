// The person's round mark: their photo, or their initials when they have none
// or it cannot be loaded. Size and colors come from whoever places it. The
// photo goes without a background, so a transparent one shows what is behind,
// inside a white ring.
import clsx from "clsx";
import { useState } from "react";

/** Up to two initials: the first letter of the first two words. */
export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0))
    .join("")
    .toUpperCase();

export function Avatar({
  name,
  photoUrl,
  className,
  fill,
}: {
  name: string;
  photoUrl: string | null;
  className?: string;
  /** Background behind the initials. */
  fill?: string;
}) {
  // The address that failed: a new photo gets its own chance.
  const [failed, setFailed] = useState<string | null>(null);
  const photo = photoUrl && photoUrl !== failed ? photoUrl : null;
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        className,
        photo ? "border-2 border-white" : fill,
      )}
    >
      {photo ? <img src={photo} alt="" draggable={false} onError={() => setFailed(photo)} className="h-full w-full object-cover" /> : initialsOf(name) || "?"}
    </span>
  );
}
