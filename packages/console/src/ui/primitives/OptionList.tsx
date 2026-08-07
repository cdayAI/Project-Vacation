import type { RefObject } from "react";
import { IconCheck } from "./icons";
import type { ListOption } from "./listbox";
import "./popup.css";
import "./OptionList.css";

/**
 * The `<ul role="listbox">` behind Select and Combobox.
 *
 * Presentation and ARIA only — every key belongs to the component that owns the
 * input, because focus stays there. Two details carry most of the correctness:
 *
 * `onMouseDown` is prevented on the whole list. Without it, pressing the
 * pointer on an option blurs the input first, the blur handler closes the list,
 * and the click lands on nothing. That is the classic "the dropdown closes when
 * I click an option" bug, and it is invisible in a keyboard-only test.
 *
 * The selected option carries a check mark as well as its weight, and the space
 * for that mark is reserved whether or not it is drawn — so choosing an option
 * does not shift every label sideways, and selection survives greyscale.
 */

export interface OptionListProps {
  readonly id: string;
  readonly options: readonly ListOption[];
  /** Where Enter would land. −1 when nothing is active. */
  readonly activeIndex: number;
  readonly selectedValue: string | null;
  /** Must agree with the `aria-activedescendant` the input publishes. */
  readonly optionId: (index: number) => string;
  readonly onPick: (option: ListOption, index: number) => void;
  readonly onHoverIndex?: (index: number) => void;
  readonly labelledBy?: string;
  readonly listRef?: RefObject<HTMLUListElement | null>;
}

export function OptionList({
  id,
  options,
  activeIndex,
  selectedValue,
  optionId,
  onPick,
  onHoverIndex,
  labelledBy,
  listRef,
}: OptionListProps) {
  return (
    <ul
      ref={listRef}
      id={id}
      className="pv-ui-listbox"
      role="listbox"
      aria-labelledby={labelledBy}
      onMouseDown={(event) => event.preventDefault()}
    >
      {options.map((option, index) => {
        const selected = option.value === selectedValue;
        return (
          <li
            key={option.value}
            id={optionId(index)}
            className="pv-ui-listbox-option"
            role="option"
            aria-selected={selected}
            aria-disabled={option.disabled === true ? true : undefined}
            data-active={index === activeIndex ? "true" : undefined}
            onMouseMove={() => {
              if (option.disabled !== true) onHoverIndex?.(index);
            }}
            onClick={() => {
              if (option.disabled !== true) onPick(option, index);
            }}
          >
            {selected && <IconCheck className="pv-ui-listbox-check" size="sm" />}
            <span className="pv-ui-listbox-text">
              <span className="pv-ui-listbox-label">{option.label}</span>
              {option.description !== undefined && (
                <span className="pv-ui-listbox-description">{option.description}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
