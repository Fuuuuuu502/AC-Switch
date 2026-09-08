/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#101512",
        panel: "#19211d",
        card: "#19211d",
        line: "rgba(255,255,255,0.08)",
        accent: "#a8e4ce",
        mist: "#a0afa7",
      },
      boxShadow: {
        card: "0 10px 30px -18px rgba(0,0,0,0.7)",
        glow: "0 0 0 1px rgba(109,124,255,0.35), 0 12px 40px -20px rgba(109,124,255,0.55)",
      },
      fontSize: {
        "2xs": ["11px", "16px"],
      },
    },
  },
  plugins: [],
};

