"use client";

import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { theme, ready, toggleTheme } = useTheme();
  // Until ready, render the same markup the server sent (light) to avoid hydration mismatch.
  const isDark = ready && theme === "dark";

  return (
    <button
      type="button"
      className="btn btn-secondary theme-toggle"
      onClick={toggleTheme}
      disabled={!ready}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      <span className="theme-toggle-icon" aria-hidden>
        {isDark ? "☀" : "☾"}
      </span>
      <span className="theme-toggle-label">{isDark ? "Light" : "Dark"}</span>
    </button>
  );
}
