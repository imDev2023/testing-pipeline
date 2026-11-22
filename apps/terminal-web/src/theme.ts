/**
 * The reader's theme choice: light, dark, or the device's setting. A chosen theme is kept in this
 * cookie, which the root layout writes onto <html> as `data-theme`, so a page never paints the
 * other theme first; the device's setting is no cookie at all (PIPESCOPE-68).
 */
export const THEME_COOKIE = "terminal_theme";
export type ThemeChoice = "light" | "dark" | "device";
export const isChosenTheme = (value: string | undefined): value is "light" | "dark" => value === "light" || value === "dark";
