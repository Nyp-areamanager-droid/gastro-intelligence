/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'brand-red':  '#e63027',
        'brand-dark': '#07090f',
        'surface':    '#111827',
        'surface2':   '#1a2233',
        'border-dim': '#1f2d45',
        'border2':    '#2a3d5a',
        'muted':      '#8a9bb5',
      },
      fontFamily: {
        head: ['var(--font-syne)', 'sans-serif'],
        mono: ['var(--font-dm-mono)', 'monospace'],
        sans: ['var(--font-dm-sans)', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
