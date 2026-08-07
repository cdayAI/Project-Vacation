/**
 * Class name joining.
 *
 * Every primitive in this directory has at most a root class plus a caller
 * override, and variants are carried on `data-` attributes rather than on a
 * second class. That keeps the CSS selector readable — `[data-variant="danger"]`
 * says what it matches — and it keeps this helper to the three lines it should
 * be rather than a class name grammar nobody can grep for.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}
