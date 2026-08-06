import type { BreadcrumbEntry } from "../routes";
import { Link } from "../routing";
import "./Breadcrumb.css";

/**
 * Where you are, and how you got here.
 *
 * The trail is computed in routes.tsx by walking the route hierarchy, not by
 * splitting the URL — see `breadcrumbFor` for why that distinction is the whole
 * point. This component's only job is to draw it correctly, which for a
 * breadcrumb means three things people routinely get wrong:
 *
 *   - It is a `<nav>` with a name, because a screen-reader user lands on a page
 *     with several navigations and "Breadcrumb" is how they tell which is this.
 *   - It is an ordered list, because the order is the meaning.
 *   - The last crumb is **not a link**. It carries `aria-current="page"` and no
 *     href: a link to the page you are already on is a link that does nothing,
 *     and it is the one crumb people click by mistake.
 *
 * The separator is a character in an `aria-hidden` span rather than a CSS
 * `::after`, so that a copied breadcrumb pastes as readable text and a
 * high-contrast mode that drops backgrounds does not drop the structure.
 */

export interface BreadcrumbProps {
  readonly entries: readonly BreadcrumbEntry[];
}

export function Breadcrumb({ entries }: BreadcrumbProps) {
  if (entries.length === 0) return null;

  return (
    <nav className="pv-breadcrumb" aria-label="Breadcrumb">
      <ol className="pv-breadcrumb-list">
        {entries.map((entry, index) => (
          <li
            className="pv-breadcrumb-item"
            key={entry.id}
            // The last crumb is the one that survives a narrow window; the
            // ones before it are dropped in CSS from the front, because the
            // thing you need to read is where you are.
            data-position={index === entries.length - 1 ? "last" : "ancestor"}
          >
            {index > 0 ? (
              <span className="pv-breadcrumb-separator" aria-hidden="true">
                /
              </span>
            ) : null}
            {entry.path === undefined ? (
              <span
                className="pv-breadcrumb-label"
                aria-current={entry.current ? "page" : undefined}
              >
                {entry.label}
              </span>
            ) : (
              <Link to={entry.path} className="pv-breadcrumb-link">
                {entry.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
