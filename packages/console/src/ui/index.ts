/**
 * The component library.
 *
 * One import for everything a screen builds out of. The four sub-barrels below
 * are owned by the people who wrote what is in them; this file is assembled
 * centrally, once, and does nothing but put the four together.
 *
 * -----------------------------------------------------------------------------
 * WHY THE FAMILIES ARE SEPARATE AND THE ENTRANCE IS NOT
 *
 * `primitives` are the atoms, `surfaces` are what a screen is arranged out of,
 * `domain` is where the product stops looking generic, and `palette` is the
 * keyboard's front door. That split is how the library is *maintained* — it
 * keeps a second chip or a second idea of read-only from being invented one
 * directory over.
 *
 * It is not how the library is *used*. A screen needs a Button, a Table, and an
 * ApprovalCard in the same breath, and making it name three paths to get them
 * would leak our filing system into every consumer and freeze it: moving a
 * component between families would then be a change to every screen that
 * imports it, rather than a change to one line here.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS NOT HERE
 *
 * Names are re-exported flat, and that is checked rather than hoped for — the
 * four families export 278 names between them with no collision, and a new one
 * would fail this file's compilation rather than silently shadowing something.
 *
 * The theme lives in `src/theme` and the keyboard model in `src/keyboard`.
 * Neither is re-exported here. A component library that also hands out the
 * token set invites a screen to import a colour, and the whole point of the
 * token system is that a screen never names one.
 *
 * Every component in here appears in the gallery at `/design`, in every state it
 * has. That page walks this directory and fails its test when a component is
 * missing from it, so the gallery cannot quietly fall behind the library.
 */

export * from "./primitives";
export * from "./surfaces";
export * from "./domain";
export * from "./palette";
