import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Tag, X } from "lucide-react";

type TagComboboxProps = {
  value: string[];
  options: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
  // When true, typing a tag that isn't in the list and pressing Enter adds it.
  allowNew?: boolean;
  label: string;
};

// Multi-select tag picker: selected tags show as removable chips.
export function TagCombobox({ value, options, onChange, placeholder, allowNew = false, label }: TagComboboxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const term = query.trim();
  const matches = options.filter((tag) => !value.includes(tag) && tag.toLowerCase().includes(term.toLowerCase())).slice(0, 8);
  const canCreate = allowNew && term !== "" && !options.some((tag) => tag.toLowerCase() === term.toLowerCase()) && !value.includes(term);
  const choices = canCreate ? [...matches, term] : matches;

  const add = (tag: string) => {
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, choices.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === "Enter" && open && choices[active]) { event.preventDefault(); add(choices[active]); }
    else if (event.key === "Escape") setOpen(false);
    else if (event.key === "Backspace" && !query && value.length) onChange(value.slice(0, -1));
  };

  return (
    <div className="hh-tagbox" onClick={() => inputRef.current?.focus()}>
      <Tag size={14} aria-hidden="true" />
      {value.map((tag) => (
        <span className="hh-chip" key={tag}>
          {tag}
          <button type="button" aria-label={`Remove tag ${tag}`} onClick={(event) => { event.stopPropagation(); onChange(value.filter((t) => t !== tag)); }}><X size={11} /></button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={query}
        role="combobox"
        aria-label={label}
        aria-expanded={open && choices.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && choices[active] ? `${listId}-${active}` : undefined}
        placeholder={value.length ? "" : placeholder}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="hh-tagbox-list" id={listId} role="listbox">
          {choices.length ? choices.map((tag, index) => (
            <li
              key={tag}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseDown={(event) => { event.preventDefault(); add(tag); }}
            >
              {canCreate && index === choices.length - 1 ? <>Add “{tag}”</> : tag}
            </li>
          )) : <li className="empty" role="presentation">{options.length ? "No more tags" : allowNew ? "Type a tag and press Enter" : "No tags on these properties yet"}</li>}
        </ul>
      )}
    </div>
  );
}
