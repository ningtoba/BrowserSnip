/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'SF Mono', 'ui-monospace', 'Menlo', 'monospace'],
        display: ['Space Grotesk', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'system-ui', 'sans-serif'],
        body: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: {
          DEFAULT: '#1B1B18',
          soft: '#55554E',
          muted: '#75756B',
        },
        cream: {
          DEFAULT: '#F7F7F4',
          light: '#FFFFFF',
          border: '#E3E3DD',
          soft: '#F1F1EC',
        },
        accent: {
          DEFAULT: '#2563EB',
          hover: '#1D4ED8',
          ring: 'rgba(37, 99, 235, 0.18)',
        },
        success: '#059669',
        warn: '#D97706',
        danger: '#DC2626',
        // v3 "Studio" category accent set — icon tiles, eyebrows, active tab only.
        acc: {
          blue: { DEFAULT: '#2563EB', tint: 'rgba(37, 99, 235, 0.08)' },
          violet: { DEFAULT: '#7C3AED', tint: 'rgba(124, 58, 237, 0.08)' },
          emerald: { DEFAULT: '#059669', tint: 'rgba(5, 150, 105, 0.08)' },
          amber: { DEFAULT: '#D97706', tint: 'rgba(217, 119, 6, 0.08)' },
          rose: { DEFAULT: '#E11D48', tint: 'rgba(225, 29, 72, 0.07)' },
        },
      },
      borderRadius: {
        doodle: '8px',
        'doodle-md': '12px',
        'doodle-lg': '16px',
      },
      animation: {
        'doodle-pop': 'doodle-pop 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'fade-in': 'fade-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-left': 'slide-in-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slide-up 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'doodle-pop': {
          '0%': { transform: 'scale(0.97)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 4px rgba(37, 99, 235, 0.10)' },
          '50%': { boxShadow: '0 0 0 6px rgba(37, 99, 235, 0.16)' },
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
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      boxShadow: {
        doodle: '0 1px 2px rgba(27, 27, 24, 0.05)',
        'doodle-hover': '0 8px 24px rgba(27, 27, 24, 0.09), 0 2px 6px rgba(27, 27, 24, 0.05)',
        'doodle-card': '0 1px 2px rgba(27, 27, 24, 0.05)',
        'doodle-focus': '0 0 0 3px rgba(37, 99, 235, 0.25)',
        glow: '0 0 0 4px rgba(37, 99, 235, 0.10)',
        'card-hover': '0 12px 32px rgba(27, 27, 24, 0.10)',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
