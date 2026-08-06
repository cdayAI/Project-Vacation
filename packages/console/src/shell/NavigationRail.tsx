import type { NavigationZone } from "../routes";
import { Link } from "../routing";
import "./NavigationRail.css";

/**
 * The rail: 240px of the console that is in the same place every morning.
 *
 * Four zones in the fixed order specification §2 gives — **Work · Oversight ·
 * Improve · Admin** — holding only the surfaces this role can open, with an
 * empty zone dropped entirely rather than drawn as a heading over nothing.
 *
 * Two things it deliberately does not do:
 *
 * **It does not reorder itself.** Not by frequency, not by recency, not by
 * anything. The command palette is where "what I use most" belongs, and it
 * learns; the rail's whole value is muscle memory, and a rail that moves has
 * none. The two mechanisms are complementary and putting learning in both would
 * have made the rail worse to make the palette redundant.
 *
 * **The active item is never a full-bleed accent fill.** A 3px bar and
 * `surface-raised`, per §2. A saturated block in a rail is the loudest thing on
 * a screen whose actual subject is a decision worth several thousand dollars.
 *
 * -----------------------------------------------------------------------------
 * COLLAPSED TO 64px
 *
 * The label is not removed when the rail collapses — it is moved. It stays in
 * the DOM at zero opacity, laid out as a chip beside the icon, and appears on
 * hover and on keyboard focus. That is what keeps every link named for a screen
 * reader at 64px, and it is why this does not use the Tooltip primitive: a
 * tooltip is supplementary detail, and here the label is the name.
 */

export interface NavigationRailProps {
  readonly zones: readonly NavigationZone[];
  readonly collapsed: boolean;
  /** The glass or designed-solid class the shell leased for its chrome. */
  readonly surfaceClassName: string;
}

export function NavigationRail({ zones, collapsed, surfaceClassName }: NavigationRailProps) {
  return (
    <nav
      id="primary-navigation"
      className={`pv-rail ${surfaceClassName}`}
      aria-label="Primary"
      data-collapsed={collapsed ? "true" : undefined}
    >
      <ul className="pv-rail-zones">
        {zones.map((zone) => (
          <li className="pv-rail-zone" key={zone.id}>
            {/* A heading rather than a styled span: the zones are the
                structure of this navigation, and a screen-reader user moving by
                heading is how they skip three zones to reach Admin. */}
            <h2 className="pv-rail-zone-label" id={`rail-zone-${zone.id}`}>
              {zone.label}
            </h2>
            <ul className="pv-rail-items" aria-labelledby={`rail-zone-${zone.id}`}>
              {zone.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link to={item.path} className="pv-rail-link" markCurrent>
                      <span className="pv-rail-link-mark" aria-hidden="true">
                        <Icon />
                      </span>
                      <span className="pv-rail-link-label">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
