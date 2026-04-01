import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: "#0d1117", secondary: "#161b22", tertiary: "#21262d" },
        border: { DEFAULT: "#30363d" },
        accent: { DEFAULT: "#58a6ff" },
      },
      fontFamily: {
        sans: ["Monaco", "PingFang SC", "Microsoft YaHei", "Source Han Sans CN", "Noto Sans CJK SC", "Consolas", "Courier New", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
