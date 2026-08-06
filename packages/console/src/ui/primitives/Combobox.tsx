import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Field } from "./Field";
import { IconChevronDown, IconCross } from "./icons";
import type { ControlSize } from "./Input";
import {
  firstEnabledIndex,
  indexOfValue,
  lastEnabledIndex,
  stepIndex,
  useScrollActiveIntoView,
  type ListOption,
} from "./listbox";
import { OptionList } from "./OptionList";
import { Spinner } from "./Spinner";
import "./control.css";
import "./popup.css";
import "./Select.css";

/**
 * Combobox — type to narrow a long list, then choose.
 *
 * The difference from Select is not cosmetic: the focus is in a text field, so
 * every key an operator expects a text field to have must keep working. That
 * rules out three things a select does:
 *
 *   Home and End move the caret, they do not jump to the first or last option.
 *   Taking them would break the one shortcut people use to fix a typo at the
 *   start of what they typed.
 *
 *   Type-ahead is not a separate mechanism. Typing filters.
 *
 *   Tab does not commit the active option. In a select, Tab picking the
 *   highlighted row matches the native control. Here the operator may have
 *   typed three characters of a name and be tabbing away to check something —
 *   committing whatever happened to be highlighted would put a value they never
 *   chose onto a record. Leaving restores the field to the value it holds.
 *
 * Escape and Tab undo the edit: both the text and the value go back to what
 * they were when typing started, so the field never displays something it does
 * not hold and an abandoned edit never changes a record. Escape does not clear
 * the field — destroying an operator's value is not a dismissal. Clearing is
 * its own button, and emptying the box and leaving does it too.
 *
 * With no matches the popup does not open. An `aria-expanded="true"` whose
 * `aria-controls` points at a box containing a sentence rather than options is
 * a state no screen reader can describe; the "no matches" line is a status
 * message instead, which is announced without lying about the widget.
 */

export interface ComboboxProps {
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly options: readonly ListOption[];
  /** Controlled. `null` is "nothing chosen", never an empty string. */
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  /**
   * Every keystroke, for a caller that fetches its own options. Typing is never
   * blocked or debounced here (spec §7) — a caller that needs to throttle a
   * request does it where the request is made.
   */
  readonly onQueryChange?: (query: string) => void;
  /** The caller has already filtered; render `options` as given. */
  readonly externalFilter?: boolean;
  /**
   * Lets the operator commit text that matches no option — a reason code that
   * does not exist yet, a free-form owner name. Off by default: a value that is
   * not in the list is usually a typo, and finding out later is expensive.
   */
  readonly allowCustomValue?: boolean;
  readonly placeholder?: string;
  readonly size?: ControlSize;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  readonly id?: string;
  readonly className?: string;
}

function labelOf(options: readonly ListOption[], value: string | null): string {
  const index = indexOfValue(options, value);
  return index >= 0 ? (options[index]?.label ?? "") : (value ?? "");
}

function matches(option: ListOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (option.label.toLowerCase().includes(needle)) return true;
  return option.description?.toLowerCase().includes(needle) === true;
}

export function Combobox({
  label,
  labelHidden,
  hint,
  error,
  options,
  value,
  onChange,
  onQueryChange,
  externalFilter = false,
  allowCustomValue = false,
  placeholder = "Type to search",
  size = "md",
  required = false,
  disabled = false,
  readOnly = false,
  loading = false,
  loadingLabel = "Searching",
  id,
  className,
}: ComboboxProps) {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-listbox`;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const committedLabel = labelOf(options, value);
  const [query, setQuery] = useState(committedLabel);
  /** True once the operator has typed since the last commit. */
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // The value can change from outside — a form reset, a linked field, a record
  // arriving. The text has to follow it, or the box shows one thing and the
  // record holds another. Adjusting during render rather than in an effect
  // avoids painting the stale label for a frame. Never while the operator is
  // typing: this component clears the committed value on the first keystroke,
  // and syncing on that would delete what they were in the middle of writing.
  const [seenValue, setSeenValue] = useState<string | null>(value);
  if (seenValue !== value && !dirty) {
    setSeenValue(value);
    setQuery(committedLabel);
  }

  // While the field is untouched the whole list is offered: an operator who
  // opens a field that already holds "Rescission" wants to see the alternatives,
  // not the one option that matches the text already in the box.
  const filtered =
    externalFilter || !dirty ? options : options.filter((option) => matches(option, query));

  useScrollActiveIntoView(listRef, activeIndex, open);

  const listShown = open && filtered.length > 0;
  const noMatches = open && filtered.length === 0 && !loading;

  /**
   * What an abandoned edit goes back to.
   *
   * Captured when typing starts, because the first keystroke drops the
   * committed value — a box reading "Dana Ruizx" must not still hold Dana Ruiz,
   * or a form submitted mid-edit saves a choice nobody made. Escape and Tab put
   * both the text and the value back.
   */
  const restoreTo = useRef<string | null>(value);

  function beginEdit() {
    if (!dirty) restoreTo.current = value;
  }

  /** Escape and Tab: undo the edit entirely. */
  function revert() {
    const target = restoreTo.current;
    if (target !== value) onChange(target);
    setQuery(labelOf(options, target));
    setDirty(false);
  }

  /**
   * Blur: an emptied box is a clear, anything else is an abandoned edit.
   *
   * The distinction is the operator's intent. Deleting everything and leaving
   * says "nobody"; typing three letters and wandering off says nothing at all,
   * and reverting is the only reading of it that cannot lose a value.
   */
  function settle() {
    if (query.trim().length === 0) {
      if (value !== null) onChange(null);
      restoreTo.current = null;
      setQuery("");
      setDirty(false);
      return;
    }
    revert();
  }

  function close() {
    setOpen(false);
    setActiveIndex(-1);
  }

  function commit(index: number) {
    const option = filtered[index];
    if (option === undefined || option.disabled === true) return;
    restoreTo.current = option.value;
    onChange(option.value);
    setQuery(option.label);
    setDirty(false);
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled || readOnly) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!listShown) {
          setOpen(true);
          setActiveIndex(firstEnabledIndex(filtered));
        } else {
          setActiveIndex(stepIndex(filtered, activeIndex, 1, true));
        }
        return;
      case "ArrowUp":
        event.preventDefault();
        if (event.altKey) {
          close();
          return;
        }
        if (!listShown) {
          setOpen(true);
          setActiveIndex(lastEnabledIndex(filtered));
        } else {
          setActiveIndex(stepIndex(filtered, activeIndex, -1, true));
        }
        return;
      case "Enter": {
        if (activeIndex >= 0 && listShown) {
          event.preventDefault();
          commit(activeIndex);
          return;
        }
        const exact = filtered.findIndex(
          (option) =>
            option.disabled !== true &&
            option.label.toLowerCase() === query.trim().toLowerCase(),
        );
        if (exact >= 0) {
          event.preventDefault();
          commit(exact);
          return;
        }
        if (allowCustomValue && query.trim().length > 0) {
          event.preventDefault();
          restoreTo.current = query.trim();
          onChange(query.trim());
          setDirty(false);
          close();
        }
        // Otherwise Enter belongs to the form: ⌘Enter submits, and swallowing a
        // plain Enter in a field with nothing to commit is how a form stops
        // responding to the keyboard.
        return;
      }
      case "Escape":
        if (!open && !dirty) return;
        event.preventDefault();
        revert();
        close();
        return;
      case "Tab":
        // Never commit on the way out — see the header.
        if (dirty) revert();
        close();
        return;
      default:
        return;
    }
  }

  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={error}
      required={required}
      readOnly={readOnly}
      id={id}
      className={className}
    >
      {(control) => (
        <div className="pv-ui-popup">
          <div
            className="pv-ui-control"
            data-size={size}
            data-open={listShown ? "true" : undefined}
            data-invalid={control.invalid ? "true" : undefined}
            data-readonly={control.readOnly ? "true" : undefined}
            data-disabled={disabled ? "true" : undefined}
          >
            <input
              ref={inputRef}
              id={control.id}
              className="pv-ui-control-field"
              type="text"
              // Read-only drops the combobox semantics entirely rather than
              // presenting a combobox that will not expand: there is no popup,
              // nothing to autocomplete, and announcing one is a promise the
              // control cannot keep. It is a read-only text value.
              role={control.readOnly ? undefined : "combobox"}
              autoComplete="off"
              // The browser's own suggestion list would sit over ours, and its
              // arrow keys would fight with these.
              spellCheck={false}
              aria-expanded={control.readOnly ? undefined : listShown}
              aria-controls={listShown ? listId : undefined}
              aria-autocomplete={control.readOnly ? undefined : "list"}
              aria-activedescendant={
                listShown && activeIndex >= 0 ? optionId(activeIndex) : undefined
              }
              aria-describedby={control.describedBy}
              aria-invalid={control.invalid ? true : undefined}
              aria-busy={loading ? true : undefined}
              required={control.required}
              readOnly={control.readOnly}
              disabled={disabled}
              placeholder={control.readOnly ? undefined : placeholder}
              value={control.readOnly ? committedLabel : query}
              onChange={(event) => {
                const next = event.target.value;
                beginEdit();
                setQuery(next);
                setDirty(true);
                setOpen(true);
                setActiveIndex(-1);
                onQueryChange?.(next);
                // Typing past the committed value means it no longer holds:
                // leaving the old value behind while the box says something
                // else is how a form saves what nobody chose. `restoreTo`
                // remembers it, so Escape and Tab can put it back.
                if (value !== null) onChange(null);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => {
                settle();
                close();
              }}
            />
            {loading && (
              <span className="pv-ui-control-addon">
                <Spinner size="sm" label={loadingLabel} />
              </span>
            )}
            {!control.readOnly && value !== null && !required && (
              <button
                type="button"
                className="pv-ui-control-button"
                aria-label={`Clear ${label}`}
                disabled={disabled}
                onClick={() => {
                  restoreTo.current = null;
                  onChange(null);
                  setQuery("");
                  setDirty(false);
                  close();
                  inputRef.current?.focus();
                }}
              >
                <IconCross size="sm" />
              </button>
            )}
            {!control.readOnly && <IconChevronDown className="pv-ui-select-chevron" />}
          </div>

          {listShown && (
            <div className="pv-ui-popup-layer">
              <OptionList
                id={listId}
                options={filtered}
                activeIndex={activeIndex}
                selectedValue={value}
                optionId={optionId}
                onPick={(_option, index) => commit(index)}
                onHoverIndex={setActiveIndex}
                labelledBy={control.id}
                listRef={listRef}
              />
            </div>
          )}

          {noMatches && (
            <div className="pv-ui-popup-layer">
              <p className="pv-ui-listbox-empty" role="status">
                {`No matches for “${query.trim()}”. Check the spelling, or clear the field to see everything.`}
              </p>
            </div>
          )}
        </div>
      )}
    </Field>
  );
}
