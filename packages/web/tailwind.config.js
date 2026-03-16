/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#1E1D1F',
        card: '#282729',
        primary: {
          DEFAULT: '#74c69d',
          dark: '#5eb78a',
          darker: '#40916c',
          light: '#95d5b2',
          lighter: '#b7e4c7',
          lightest: '#d8f3dc',
        },
        border: 'rgba(116, 198, 157, 0.2)',
      },
      borderRadius: {
        lg: '0.5rem',
        md: 'calc(0.5rem - 2px)',
        sm: 'calc(0.5rem - 4px)',
      },
    },
  },
  plugins: [],
};
