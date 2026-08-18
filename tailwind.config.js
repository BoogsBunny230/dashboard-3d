/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,html}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Colores semánticos para estados de equipo
        'status-running': '#22c55e',   // Green 500
        'status-idle': '#eab308',      // Yellow 500
        'status-error': '#ef4444',     // Red 500
        'status-maintenance': '#3b82f6', // Blue 500
        'status-offline': '#6b7280',   // Gray 500
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
