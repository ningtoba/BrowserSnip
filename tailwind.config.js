/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'SF Mono', 'ui-monospace', 'Menlo', 'monospace'],
        display: ['Comic Sans MS', 'Trebuchet MS', 'sans-serif'],
        body: ['Comic Sans MS', 'Trebuchet MS', 'sans-serif'],
      },
      colors: {
        // Doodle palette
        ink: {
          DEFAULT: '#1d1836',
          soft: '#4c426c',
          muted: '#796f91',
        },
        cream: {
          DEFAULT: '#fff8d7',
          light: '#ffef9f',
          border: '#eadfba',
          soft: '#f5eccd',
        },
        accent: {
          DEFAULT: '#ff6b00',
          hover: '#e55d00',
          ring: 'rgba(255, 107, 0, 0.26)',
        },
        success: '#2e9d57',
        warn: '#ffb020',
        danger: '#e5484d',
      },
      borderRadius: {
        'doodle': '10px',
        'doodle-md': '16px',
        'doodle-lg': '24px',
      },
      animation: {
        'doodle-pop': 'doodle-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'wiggle': 'wiggle 0.5s ease-in-out',
      },
      keyframes: {
        'doodle-pop': {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 8px rgba(255, 107, 0, 0.3)' },
          '50%': { boxShadow: '0 0 20px rgba(255, 107, 0, 0.6)' },
        },
        'wiggle': {
          '0%, 100%': { transform: 'rotate(0deg)' },
          '25%': { transform: 'rotate(-2deg)' },
          '75%': { transform: 'rotate(2deg)' },
        },
      },
      boxShadow: {
        'doodle': '0 4px 0 rgba(29, 24, 54, 0.08)',
        'doodle-hover': '0 6px 0 rgba(29, 24, 54, 0.12)',
        'doodle-card': '0 18px 44px rgba(29, 24, 54, 0.10)',
        'doodle-focus': '0 0 0 4px rgba(255, 107, 0, 0.26)',
      },
    },
  },
  plugins: [],
};
