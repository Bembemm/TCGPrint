import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["tesseract.js", "tesseract.js-core", "@tesseract.js-data/eng"],
};

export default nextConfig;
