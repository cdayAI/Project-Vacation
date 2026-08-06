/**
 * Ambient declarations for the non-TypeScript imports the bundler handles.
 *
 * The `?raw` form is how the token file is read back in the contrast test: the
 * test parses the stylesheet the application actually ships rather than a
 * duplicate list of colours, so there is no second copy to drift.
 */
declare module "*.css" {
  const stylesheet: string;
  export default stylesheet;
}

declare module "*.css?raw" {
  const source: string;
  export default source;
}
