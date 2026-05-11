/** @type {import('tailwindcss').Config} */
// VITOM IT Crew – paleta podle oficiálního brand manuálu VITOM realitní ekosystém (2024):
//   Midnight Green #0C363E – primární tmavá teal (sidebar, nadpisy, primární akce)
//   Linen          #EEE9E4 – krémové pozadí (papírová barva celé aplikace)
//   Cerise         #E72B78 – akcentní magenta (CTA, badge, zvýraznění)
// Sekundární písmo: Source Sans Pro (Rustica je placené – ekvivalentně používáme SSP).
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Source Sans 3"', '"Source Sans Pro"', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        display: ['"Source Sans 3"', '"Source Sans Pro"', 'sans-serif'],
      },
      colors: {
        // Midnight Green – primární brand (#0C363E je oficiální barva z manuálu)
        brand: {
          50:  '#e8eef0',
          100: '#c4d3d6',
          200: '#9bb3b8',
          300: '#6e8f96',
          400: '#1f4d56',
          500: '#0c363e',  // ← oficiální Midnight Green
          600: '#0a2c33',  // hover/aktivní stav
          700: '#082327',
          800: '#061b1f',
          900: '#04181c',
        },
        // Cerise – akcent
        accent: {
          50:  '#fde6ef',
          100: '#fac1d6',
          200: '#f48bb1',
          300: '#ee5a92',
          400: '#eb3f81',
          500: '#e72b78',  // ← oficiální Cerise
          600: '#cc1d65',
          700: '#a51851',
          800: '#7e123e',
          900: '#570c2b',
        },
        // Linen – krémové pozadí (60 % Pantone 7528 C)
        cream: {
          50:  '#f9f6f1',
          100: '#eee9e4',  // ← oficiální Linen
          200: '#e2dcd3',
          300: '#d2c9bb',
          400: '#bbb0a0',
        },
        // Doplňková paleta pro text
        ink: {
          900: '#0c1f23',
          800: '#13292e',
          700: '#1f3a40',
          600: '#365156',
          500: '#5b7177',
          400: '#8a9b9f',
          300: '#bac6c9',
        },
      },
    },
  },
  plugins: [],
};
