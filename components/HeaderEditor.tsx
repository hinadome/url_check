"use client";

import type { HeaderPair } from "@/lib/types";

type HeaderEditorProps = {
  headers: HeaderPair[];
  onChange: (headers: HeaderPair[]) => void;
  disabled?: boolean;
};

export function HeaderEditor({ headers, onChange, disabled }: HeaderEditorProps) {
  const updateRow = (index: number, field: keyof HeaderPair, value: string) => {
    const next = headers.map((row, i) =>
      i === index ? { ...row, [field]: value } : row,
    );
    onChange(next);
  };

  const removeRow = (index: number) => {
    onChange(headers.filter((_, i) => i !== index));
  };

  const addRow = () => {
    onChange([...headers, { name: "", value: "" }]);
  };

  return (
    <div className="header-editor">
      <div className="header-editor-label">
        <span>Custom headers</span>
        <button type="button" className="btn btn-secondary" onClick={addRow} disabled={disabled}>
          Add header
        </button>
      </div>
      {headers.length === 0 ? (
        <p className="muted">No custom headers. Optional — add User-Agent, Authorization, etc.</p>
      ) : (
        <ul className="header-list">
          {headers.map((row, index) => (
            <li key={index} className="header-row">
              <input
                type="text"
                placeholder="Header name"
                value={row.name}
                onChange={(e) => updateRow(index, "name", e.target.value)}
                disabled={disabled}
                aria-label={`Header name ${index + 1}`}
              />
              <input
                type="text"
                placeholder="Header value"
                value={row.value}
                onChange={(e) => updateRow(index, "value", e.target.value)}
                disabled={disabled}
                aria-label={`Header value ${index + 1}`}
              />
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => removeRow(index)}
                disabled={disabled}
                aria-label={`Remove header ${index + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
