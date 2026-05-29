/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'SF Mono', 'ui-monospace', 'Menlo', 'monospace'],
        display: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'system-ui', 'sans-serif'],
        body: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: {
          DEFAULT: '#eeeff5',
          soft: '#a8adc4',
          muted: '#5c6080',
        },
        cream: {
          DEFAULT: '#0a0b10',
          light: '#11131c',
          border: '#1e2035',
          soft: '#161922',
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#818cf8',
          ring: 'rgba(99, 102, 241, 0.25)',
        },
        success: '#34d399',
        warn: '#fbbf24',
        danger: '#f87171',
      },
      borderRadius: {
        doodle: '6px',
        'doodle-md': '10px',
        'doodle-lg': '14px',
      },
      animation: {
        'doodle-pop': 'doodle-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-in-left': 'slide-in-left 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'doodle-pop': {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 12px rgba(99, 102, 241, 0.3)' },
          '50%': { boxShadow: '0 0 28px rgba(99, 102, 241, 0.6)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in-left': {
          '0%': { transform: 'translateX(-100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      boxShadow: {
        doodle: '0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)',
        'doodle-hover': '0 4px 16px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.3)',
        'doodle-card': '0 2px 8px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2)',
        'doodle-focus': '0 0 0 3px rgba(99, 102, 241, 0.35)',
        glow: '0 0 20px rgba(99, 102, 241, 0.2)',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
};
