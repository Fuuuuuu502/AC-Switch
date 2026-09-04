/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#111827",
        card: "#1f2937",
        line: "#374151",
        accent: "#6366f1",
      },
    },
  },
  plugins: [],
};

