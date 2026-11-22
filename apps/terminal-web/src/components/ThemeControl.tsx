"use client";

import { useState } from "react";
import { THEME_COOKIE, type ThemeChoice } from "@/theme";
import styles from "./ThemeControl.module.css";

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "device", label: "Device" },
];

/** Puts a choice on the page at once, and keeps it for the next page (or forgets it, for the device's). */
function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "device") {
    delete root.dataset.theme;
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } else {
    root.dataset.theme = choice;
    document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
  }
}

/**
 * Light, dark or the device's setting (PIPESCOPE-68). A chosen theme is kept in a cookie the root
 * layout reads, so the next page paints in it from the first frame; "Device" removes the cookie and
 * the page follows the device again.
 */
export function ThemeControl({ initial }: { initial: ThemeChoice }) {
  const [choice, setChoice] = useState<ThemeChoice>(initial);

  function choose(next: ThemeChoice) {
    applyTheme(next);
    setChoice(next);
  }

  return (
    <fieldset className={styles.control}>
      <legend className={styles.legend}>Theme</legend>
      <div className={styles.options}>
        {CHOICES.map(({ value, label }) => (
          <label key={value} className={styles.option}>
            <input type="radio" name="theme" value={value} checked={choice === value} onChange={() => choose(value)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
