import { useState } from "react";
import { cx } from "./classes";
import "./Avatar.css";

/**
 * Avatar — who.
 *
 * `name` is required and is the accessible name, because an avatar with no name
 * is a decorative circle that a screen reader announces as "image". Where the
 * name is already written beside it — the usual case in a table cell — pass
 * `decorative` and it disappears from the accessibility tree rather than
 * reading the same name twice.
 *
 * A failed image falls back to initials rather than to a broken-image glyph.
 * Photographs in this console come from an identity provider that is sometimes
 * unreachable, and a row of broken images reads as a system fault.
 */

export interface AvatarProps {
  /** The person. Also the accessible name unless `decorative` is set. */
  readonly name: string;
  readonly src?: string;
  /** 28 / 32 / 40px, matching the control heights they sit beside. */
  readonly size?: "sm" | "md" | "lg";
  /** The name is already beside it: hide this from assistive technology. */
  readonly decorative?: boolean;
  readonly className?: string;
}

/**
 * "Marisol Delgado" → "MD", "M. Delgado" → "MD", "sf-quotebot" → "SF".
 *
 * First and last word rather than first two, so "Ana Maria Ruiz" is AR — the
 * initials people use for themselves. Punctuation is stripped first because
 * external agent identifiers arrive hyphenated.
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);

  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] ?? "").slice(0, 2);
  return `${(words[0] ?? "").slice(0, 1)}${(words[words.length - 1] ?? "").slice(0, 1)}`;
}

export function Avatar({ name, src, size = "md", decorative = false, className }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = src !== undefined && !imageFailed;

  return (
    <span
      className={cx("pv-ui-avatar", className)}
      data-size={size}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
    >
      {showImage ? (
        <img
          className="pv-ui-avatar-image"
          src={src}
          // The wrapper carries the name; an alt here would have it read twice.
          alt=""
          onError={() => setImageFailed(true)}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

export interface UnassignedAvatarProps {
  readonly size?: "sm" | "md" | "lg";
  readonly label?: string;
  readonly decorative?: boolean;
  readonly className?: string;
}

/**
 * The empty seat.
 *
 * Drawn as a dashed outline rather than left as a blank circle: unassigned is a
 * state the queue column shows constantly (spec §3.1), and an empty filled
 * circle reads as an avatar that failed to load.
 */
export function UnassignedAvatar({
  size = "md",
  label = "Unassigned",
  decorative = false,
  className,
}: UnassignedAvatarProps) {
  return (
    <span
      className={cx("pv-ui-avatar", className)}
      data-size={size}
      data-unassigned="true"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
    >
      <span aria-hidden="true">—</span>
    </span>
  );
}
