"use client";

import { useId, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  const listId = `${id}-models`;
  const deduped = useMemo(() => Array.from(new Set(options)), [options]);

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
      <Input
        id={id}
        list={listId}
        value={value || ""}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder || "Select or type a model (e.g. gpt-5-mini)"}
        disabled={disabled}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <datalist id={listId}>
        {deduped.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}


