/** @type {import('tailwindcss').Config} */
// Farben und Schrift kommen aus den Gestaltungsvariablen in src/app/globals.css.
// Neue Farben bitte dort ergänzen, nicht als feste Werte in einzelnen Seiten.
const v = name => `rgb(var(--${name}) / <alpha-value>)`
module.exports = {
  content: ['./src/components/**/*.{ts,tsx}', './src/app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: v('canvas'), surface: v('surface'), sunken: v('sunken'),
        ink: { DEFAULT: v('ink'), soft: v('ink-soft'), muted: v('ink-muted') },
        line: { DEFAULT: v('line'), strong: v('line-strong') },
        accent: { DEFAULT: v('accent'), hover: v('accent-hover'), soft: v('accent-soft') },
        good: { DEFAULT: v('good'), soft: v('good-soft') },
        warn: { DEFAULT: v('warn'), soft: v('warn-soft') },
        bad: { DEFAULT: v('bad'), soft: v('bad-soft') },
      },
      fontFamily: { sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'] },
      fontSize: { '2xs': ['0.6875rem', '1rem'] },
      borderRadius: { card: '10px', control: '8px' },
      boxShadow: { pop: '0 8px 28px rgb(23 33 43 / 0.14)', raise: '0 1px 2px rgb(23 33 43 / 0.06)' },
    },
  },
  plugins: [],
}
