import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: 'var(--paper)',
          deep: 'var(--paper-deep)',
          edge: 'var(--paper-edge)',
        },
        ink: {
          DEFAULT: 'var(--ink)',
          soft: 'var(--ink-soft)',
          muted: 'var(--ink-muted)',
          faint: 'var(--ink-faint)',
        },
        hairline: {
          DEFAULT: 'var(--hairline)',
          deep: 'var(--hairline-deep)',
        },
        sanguine: {
          DEFAULT: 'var(--sanguine)',
          deep: 'var(--sanguine-deep)',
          tint: 'var(--sanguine-tint)',
        },
      },
      fontFamily: {
        sans: [
          '"JetBrains Mono"',
          '"Berkeley Mono"',
          '"IBM Plex Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
        serif: [
          '"Source Serif 4"',
          'Charter',
          'Cambria',
          'Georgia',
          'serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Berkeley Mono"',
          '"IBM Plex Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      letterSpacing: {
        caps: '0.08em',
        capsTight: '0.05em',
      },
      keyframes: {
        'breathe-edge': {
          '0%, 100%': { borderColor: 'var(--hairline)' },
          '50%': { borderColor: 'var(--hairline-deep)' },
        },
        'breathe-tick': {
          '0%, 100%': { backgroundColor: 'var(--ink-muted)' },
          '50%': { backgroundColor: 'var(--ink)' },
        },
      },
      animation: {
        'breathe-edge': 'breathe-edge 2.4s ease-in-out infinite',
        'breathe-tick': 'breathe-tick 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
