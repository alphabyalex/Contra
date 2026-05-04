import type { Config } from 'tailwindcss';

/**
 * CONTRA design tokens (light theme).
 * Token names match the spec verbatim. Existing components import
 * `bg-card`, `text-text`, etc — all those tokens are remapped to the
 * new light values so the legacy components inherit the rebrand
 * without per-file edits.
 */
export default {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#F7F7F5',
        surface: '#FFFFFF',
        card: '#FFFFFF',
        border: '#E5E5E3',
        text: '#0A0A0A',
        secondary: '#4A4A4A',
        body: '#6B6B6B',
        muted: '#9B9B9B',
        accent: '#1A56DB',
        accentSoft: '#EBF0FF',
        positive: '#00875A',
        negative: '#CC2936',
        numpad: '#F0F0EE',
        warning: '#FEF3C7',
        warningText: '#92400E',
        warningBorder: '#FDE68A',
      },
      fontFamily: {
        logo: ['"DM Sans"', 'system-ui', 'sans-serif'],
        ui: ['"DM Sans"', 'system-ui', 'sans-serif'],
        num: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        logo: '0.18em',
        widest: '0.18em',
      },
      backgroundImage: {
        'dot-grid':
          'radial-gradient(circle, rgba(26,86,219,0.12) 1px, transparent 1px)',
      },
    },
  },
  plugins: [],
} satisfies Config;
