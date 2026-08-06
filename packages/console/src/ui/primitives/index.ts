/**
 * The primitives.
 *
 * The atoms every screen is made of, so most of the product's quality is
 * decided here rather than in any one screen. Everything in this directory
 * carries every state the specification asks for — default, hover,
 * focus-visible, active, disabled, loading, error, empty, and the designed
 * read-only that auditors spend their day in — and none of it reaches for a
 * value that is not a token.
 *
 * This is the primitives barrel only. `src/ui/index.ts` is assembled centrally
 * once every part of the library has landed; nothing here writes to it.
 */

export { Avatar, UnassignedAvatar, initialsOf } from "./Avatar";
export type { AvatarProps, UnassignedAvatarProps } from "./Avatar";

export { Badge } from "./Badge";
export type { BadgeProps } from "./Badge";

export { Button } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";

export { Checkbox } from "./Checkbox";
export type { CheckboxProps } from "./Checkbox";

export { Chip } from "./Chip";
export type { ChipProps } from "./Chip";

export { Combobox } from "./Combobox";
export type { ComboboxProps } from "./Combobox";

export { DatePicker } from "./DatePicker";
export type { DatePickerProps } from "./DatePicker";

export { DateRange, daysBetween, describeRange } from "./DateRange";
export type { DateRangeProps, DateRangeValue } from "./DateRange";

export { Field } from "./Field";
export type { FieldControlProps, FieldProps } from "./Field";

export { Input } from "./Input";
export type { ControlSize, InputProps } from "./Input";

export { OptionList } from "./OptionList";
export type { OptionListProps } from "./OptionList";

export { Radio, RadioGroup } from "./Radio";
export type { RadioGroupProps, RadioProps } from "./Radio";

export { Select } from "./Select";
export type { SelectProps } from "./Select";

export { Skeleton, SKELETON_DELAY_MS } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";

export { Spinner } from "./Spinner";
export type { SpinnerProps } from "./Spinner";

export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";

export { Textarea } from "./Textarea";
export type { TextareaProps } from "./Textarea";

export { Tooltip, TOOLTIP_HOVER_DELAY_MS } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";

/** The option shape Select, Combobox, and anything list-shaped speaks. */
export type { ListOption } from "./listbox";

/** Dates as text and as stored values. Exported because screens parse too. */
export {
  DATE_FORMAT_HINT,
  MONTHS_LONG,
  MONTHS_SHORT,
  addDays,
  addMonths,
  compareIso,
  daysInMonth,
  describeOutOfRange,
  describeParseFailure,
  formatDate,
  formatDateSpoken,
  formatMonth,
  fromIso,
  isWithin,
  monthGrid,
  parseDate,
  toIso,
  todayIso,
} from "./dates";
export type { CalendarDate, ParseFailure, ParseResult } from "./dates";

export {
  IconAlert,
  IconBlocked,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircle,
  IconCross,
  IconDash,
  IconDot,
  IconInfo,
  IconLock,
} from "./icons";
export type { IconProps } from "./icons";

export { useReducedMotion } from "./motion";
export { toneVariables, TONE_WORDS } from "./tone";
export { cx } from "./classes";
