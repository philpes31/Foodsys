import type { Config } from "tailwindcss";
export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: { fontFamily: { sans: ["var(--font)", "system-ui", "sans-serif"] } } },
  plugins: [],
} satisfies Config;
