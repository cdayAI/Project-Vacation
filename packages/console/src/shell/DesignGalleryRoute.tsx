import { Link } from "../routing";
import "./DesignGalleryRoute.css";

/**
 * `/design` — the component gallery's route.
 *
 * Specification §4 requires a gallery in the application itself, showing every
 * component in every state, in both themes, with and without transparency: it
 * is the review surface and the regression check, not documentation.
 *
 * The gallery's contents are built alongside the component library. This file
 * is the route it arrives at, and it is deliberately a separate file from
 * `routes.tsx` so that landing the gallery is one edit here — the body of this
 * component becomes `return <Gallery />` — rather than an edit to the shell's
 * route table that two people would collide in.
 *
 * Until then this says so plainly. A route that renders a blank page, or one
 * that is quietly left out of the table, both read as "the gallery was never
 * built"; this reads as "it is on its way, and here is what it will hold".
 */
export function DesignGalleryRoute() {
  return (
    <div className="pv-design-route">
      <h1>Design system gallery</h1>
      <p className="pv-design-lede">
        Every component, in every state, in both themes, with and without transparency. This is the
        surface a design review is held against and the one a regression shows up on first.
      </p>

      <section className="pv-design-note" aria-labelledby="design-route-status">
        <h2 id="design-route-status">The gallery is still being assembled</h2>
        <p>
          The token system, the primitives, and the surfaces are in the repository under{" "}
          <span className="pv-design-path">src/theme</span> and{" "}
          <span className="pv-design-path">src/ui</span>. The page that lays them out for review is
          landing separately, and it appears here when it does.
        </p>
        <p>
          In the meantime the design authority is{" "}
          <span className="pv-design-path">docs/design/design-spec.md</span>, and every component
          carries its states in its own test file.
        </p>
        <p>
          <Link to="/work">Go to the work queue</Link>
        </p>
      </section>
    </div>
  );
}
