import { useId, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import type { ThemePreference } from "../theme/preferences";
import { Avatar } from "../ui/primitives/Avatar";
import { Button } from "../ui/primitives/Button";
import { Radio, RadioGroup } from "../ui/primitives/Radio";
import { Switch } from "../ui/primitives/Switch";
import { Popover, popoverTriggerProps } from "../ui/surfaces/Popover";
import { ReadOnlyChip } from "../ui/surfaces/ReadOnlyChip";
import "./AvatarMenu.css";

/**
 * The avatar menu: who you are, and the three ways you have asked to read the
 * console.
 *
 * Specification §2 calls this a menu carrying theme, density, reduce
 * transparency, shortcuts and sign out. It is built as a popover holding real
 * controls rather than as a `role="menu"` of toggles, and that is a deliberate
 * departure from the word "menu":
 *
 * A menu item announces as "Dark theme, menu item" and says nothing about the
 * state it is in. Three of these five entries are *settings with a current
 * value* — theme has three values, density two, transparency two — and a radio
 * group announces "Theme, Dark, selected, 3 of 3", which is the information the
 * operator actually needs. Building them as menu items would have meant
 * inventing a state announcement that the platform already gives away for free.
 *
 * The two entries that really are actions — shortcuts and sign out — are
 * buttons at the end, separated by a rule.
 */

export interface AvatarMenuProps {
  readonly name: string;
  readonly roles: readonly string[];
  readonly readOnly?: boolean;
  readonly onShowShortcuts: () => void;
  /**
   * Absent when the deployment has not wired an end-session endpoint. The
   * control is then shown refused with the reason rather than hidden: an
   * operator who cannot find sign-out assumes they are still signed in
   * somewhere, which is the more dangerous of the two misunderstandings.
   */
  readonly onSignOut?: () => void;
}

const THEME_OPTIONS: readonly { readonly value: ThemePreference; readonly label: string }[] = [
  { value: "system", label: "Match my system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AvatarMenu({
  name,
  roles,
  readOnly = false,
  onShowShortcuts,
  onSignOut,
}: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const surfaceId = useId();
  const signOutReasonId = useId();

  const {
    themePreference,
    setThemePreference,
    density,
    setDensity,
    transparency,
    setTransparency,
    reducedTransparency,
  } = useTheme();

  const roleLine = roles.length === 0 ? "No roles" : roles.join(", ");

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="pv-avatar-menu-trigger"
        // The whole of who you are, spoken: the name is on screen but the roles
        // are only in the panel, and "signed in as" is the framing that makes a
        // circle with two letters in it mean something.
        aria-label={`Signed in as ${name}. ${roleLine}. Account and preferences`}
        {...popoverTriggerProps(surfaceId, open)}
        onClick={() => setOpen((current) => !current)}
      >
        <Avatar name={name} size="sm" decorative />
        <span className="pv-avatar-menu-identity" aria-hidden="true">
          <span className="pv-avatar-menu-name">{name}</span>
          <span className="pv-avatar-menu-roles">{roleLine}</span>
        </span>
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        id={surfaceId}
        title="Account and preferences"
        placement="bottom-end"
      >
        <div className="pv-avatar-menu">
          <div className="pv-avatar-menu-header">
            <Avatar name={name} size="md" decorative />
            <div className="pv-avatar-menu-header-text">
              <p className="pv-avatar-menu-header-name">{name}</p>
              <p className="pv-avatar-menu-header-roles">{roleLine}</p>
            </div>
            {readOnly ? <ReadOnlyChip /> : null}
          </div>

          <RadioGroup
            label="Theme"
            value={themePreference}
            onChange={(value) => setThemePreference(value as ThemePreference)}
            hint="Matching your system is the default; a choice here overrides it."
          >
            {THEME_OPTIONS.map((option) => (
              <Radio key={option.value} value={option.value} label={option.label} />
            ))}
          </RadioGroup>

          <RadioGroup
            label="Density"
            value={density}
            onChange={(value) => setDensity(value === "compact" ? "compact" : "comfortable")}
            hint="Compact fits about a third more rows on a screen."
          >
            <Radio value="comfortable" label="Comfortable" />
            <Radio value="compact" label="Compact" />
          </RadioGroup>

          <Switch
            label="Reduce transparency"
            hint={
              reducedTransparency && transparency === "system"
                ? "Your system already asks for this, so it stays on."
                : "Replaces every frosted surface with a solid one."
            }
            checked={reducedTransparency}
            // Reduction is a floor, not a toggle: an operator can ask for less
            // transparency than their system does and never for more, so the
            // control cannot turn glass back on for somebody whose OS asked for
            // it to be off. See theme/preferences.ts.
            readOnly={reducedTransparency && transparency === "system"}
            onChange={(next) => setTransparency(next ? "reduced" : "system")}
          />

          <div className="pv-avatar-menu-actions">
            <Button
              variant="ghost"
              fullWidth
              onClick={() => {
                setOpen(false);
                onShowShortcuts();
              }}
            >
              Keyboard shortcuts
            </Button>

            {onSignOut === undefined ? (
              <>
                <Button variant="ghost" fullWidth unavailable describedBy={signOutReasonId}>
                  Sign out
                </Button>
                <p className="pv-avatar-menu-reason" id={signOutReasonId}>
                  Signing out is completed by your identity provider. This build has no end-session
                  endpoint configured, so closing the browser is what ends the session.
                </p>
              </>
            ) : (
              <Button
                variant="ghost"
                fullWidth
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                Sign out
              </Button>
            )}
          </div>
        </div>
      </Popover>
    </>
  );
}
