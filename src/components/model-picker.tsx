"use client";

import { useId, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

export default function ModelPicker({
  label,
  value,
  onValueChange,
  options,
  placeholder,
  description,
  disabled,
}: {
  label: string;
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const deduped = useMemo(() => Array.from(new Set(options)).filter(Boolean), [options]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string>("");

  const currentValue = value || "";
  const filterValue = open ? query : "";
  const filtered = useMemo(() => {
    const q = filterValue.trim().toLowerCase();
    if (q.length === 0) return deduped;
    return deduped.filter((m) => m.toLowerCase().includes(q));
  }, [filterValue, deduped]);

  const suggestions = filtered;

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
      <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
        <PopoverAnchor asChild>
          <Input
            id={id}
            value={currentValue}
            onChange={(e) => {
              const nextValue = e.target.value;
              onValueChange(nextValue);
              setQuery(nextValue);
              if (!open) setOpen(true);
            }}
            onFocus={() => {
              if (disabled) return;
              setQuery("");
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter") {
                setOpen(false);
                setQuery("");
              }
            }}
            placeholder={
              placeholder ||
              "Type any PydanticAI model id (e.g. openai-responses:gpt-5-mini)"
            }
            disabled={disabled}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </PopoverAnchor>
        <PopoverContent className="p-0 w-[var(--radix-popper-anchor-width)]" align="start">
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty>
                {deduped.length === 0 ? "No preset models." : "No matches."}
              </CommandEmpty>
              <CommandGroup heading="Suggestions">
                <CommandItem
                  value="__custom__"
                  onSelect={() => {
                    onValueChange("");
                    setQuery("");
                    setOpen(false);

                    requestAnimationFrame(() => {
                      const input = document.getElementById(id);
                      if (input instanceof HTMLInputElement) input.focus();
                    });
                  }}
                >
                  Custom…
                </CommandItem>
                {suggestions.map((m) => (
                  <CommandItem
                    key={m}
                    value={m}
                    onSelect={() => {
                      onValueChange(m);
                      setQuery("");
                      setOpen(false);
                    }}
                  >
                    {m}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
