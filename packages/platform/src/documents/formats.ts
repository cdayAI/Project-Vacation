import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { OUTPUT_FORMATS } from "./types.js";
import type { OutputFormat, RenderedDocument } from "./types.js";

/**
 * Rendering.
 *
 * One approved body, several formats. The template body is plain text with
 * blank lines between paragraphs, and each renderer derives its output from
 * that one string — there is no separate HTML body a reviewer never read. The
 * cost is that a template cannot carry hand-authored markup. The benefit is
 * that every format of a letter says exactly the words counsel approved, which
 * on an owner-facing disclosure is worth considerably more than layout control.
 *
 * ## PDF and DOCX are a seam, not an omission
 *
 * Both are declared in `OutputFormat` and both refuse. They are named rather
 * than left out so a template that asks for one fails with an explanation
 * instead of an unknown-value error that reads like a bug.
 *
 * **What has to be confirmed before either is built**, because guessing here
 * produces a rewrite rather than a tweak:
 *
 *   - *Which formats MVW actually uses, per document class.* Owner letters,
 *     rescission acknowledgements, statutory disclosures, association board
 *     packs, and association reporting are five different answers. Some are
 *     printed and mailed by a fulfilment vendor with its own input format; some
 *     are attached to email; some are filed. A board pack is very likely a
 *     different pipeline from an owner letter and may not belong in this module
 *     at all.
 *   - *Whether an existing MVW template estate has to be honoured.* If the
 *     disclosure library is already in Word with corporate styles, the
 *     requirement is "populate MVW's DOCX" and not "generate a DOCX", and those
 *     are different problems with different libraries.
 *   - *Accessibility and archival requirements.* Tagged PDF, PDF/A for
 *     retention, and any state e-signature or e-delivery rule that constrains
 *     the artifact.
 *   - *Where rendering runs.* A PDF renderer is a large dependency with its own
 *     vulnerability surface and, in some implementations, a headless browser.
 *     Whether that belongs inside this service or behind an integration port is
 *     a security decision, not a formatting one.
 *
 * No dependency has been added and no format has been guessed at. When the
 * answers arrive, a new renderer registers in `RENDERERS` below and nothing
 * else in the module changes.
 */

const CONTENT_TYPES: Readonly<Record<OutputFormat, string>> = {
  text: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Formats with a working renderer today. */
export const IMPLEMENTED_FORMATS: readonly OutputFormat[] = ["text", "html"];

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

export function contentTypeFor(format: OutputFormat): string {
  return CONTENT_TYPES[format];
}

/**
 * Refuse a format nothing can render.
 *
 * @throws {DeniedError} `config.missing` — a refusal rather than a validation
 *   error, because "this deployment has no renderer for that" is a statement
 *   about how the platform is configured, and it must fail closed rather than
 *   fall back to a format nobody asked for. Silently emitting plain text where
 *   a PDF disclosure was requested is the failure mode worth designing against.
 */
export function assertFormatRenderable(format: OutputFormat): void {
  if (IMPLEMENTED_FORMATS.includes(format)) return;
  throw new DeniedError(
    "config.missing",
    `No renderer is configured for "${format}". It is declared as a seam, not built: the formats MVW actually uses for owner letters, disclosures, board packs, and association reporting must be confirmed before one is written, and guessing produces a rewrite rather than a tweak. See the header of documents/formats.ts.`,
    { format },
  );
}

/**
 * Escape one merged value for a target format.
 *
 * Applied to *values*, never to the approved body, and applied at substitution
 * time rather than to the assembled document. Escaping after assembly would
 * have to distinguish the template's own structure from the values merged into
 * it, which is exactly the ambiguity that produces injection bugs.
 */
export function escapeValue(format: OutputFormat, value: string): string {
  switch (format) {
    case "html":
      return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    case "text":
      // Control characters other than newline and tab are stripped rather than
      // escaped: they are invisible in a plain-text letter, and an invisible
      // character in a legal document is a discrepancy nobody can see when they
      // compare the copy on file with the copy an owner received.
      // eslint-disable-next-line no-control-regex
      return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    default:
      assertFormatRenderable(format);
      return value;
  }
}

type Renderer = (substitutedBody: string, meta: DocumentMeta) => string;

export interface DocumentMeta {
  readonly title: string;
  readonly language: string;
}

/**
 * Normalise line endings and trailing whitespace.
 *
 * Deterministic output matters more here than it looks: the output digest is
 * recorded, compared, and cited, so a document that renders with a stray `\r`
 * on one platform and not another would produce two digests for one letter.
 */
function normalise(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const RENDERERS: Readonly<Record<"text" | "html", Renderer>> = {
  text: (body) => `${normalise(body)}\n`,

  html: (body, meta) => {
    const paragraphs = normalise(body)
      .split(/\n{2,}/)
      .filter((paragraph) => paragraph.length > 0)
      // A single newline inside a paragraph is a soft break in the source, and
      // becomes one in the output rather than being collapsed. Addresses and
      // signature blocks depend on it.
      .map((paragraph) => `  <p>${paragraph.split("\n").join("<br />\n  ")}</p>`)
      .join("\n");

    // A complete, self-contained document with no external references: no
    // stylesheet, no script, no image. A letter that renders differently
    // depending on whether a host was reachable is not a record of anything,
    // and an outbound document that fetches a remote resource leaks the fact
    // and time of reading.
    return [
      "<!DOCTYPE html>",
      `<html lang="${escapeValue("html", meta.language)}">`,
      "<head>",
      '  <meta charset="utf-8" />',
      `  <title>${escapeValue("html", meta.title)}</title>`,
      "</head>",
      "<body>",
      paragraphs,
      "</body>",
      "</html>",
      "",
    ].join("\n");
  },
};

/**
 * Assemble a rendered document from an already-substituted body.
 *
 * @throws {DeniedError} `config.missing` for a format with no renderer.
 */
export function assembleDocument(
  format: OutputFormat,
  substitutedBody: string,
  meta: DocumentMeta,
): RenderedDocument {
  assertFormatRenderable(format);
  if (format !== "text" && format !== "html") {
    // Unreachable while IMPLEMENTED_FORMATS holds only these two; kept so that
    // adding a format to that list without adding a renderer fails here rather
    // than emitting an empty document.
    throw new InvalidInputError(`Format "${format}" is listed as renderable but has no renderer.`);
  }
  const body = RENDERERS[format](substitutedBody, meta);
  return {
    format,
    body,
    // The digest covers the format as well as the bytes, so a plain-text and an
    // HTML rendering of one letter are distinguishable in the audit record.
    // They are different artifacts and only one of them was delivered.
    outputDigest: digestValue({ format, body }),
    contentType: contentTypeFor(format),
  };
}
