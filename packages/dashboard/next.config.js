const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    tsconfigPath: "./tsconfig.build.json",
  },
  basePath: "/dashboard",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: process.env.NEXT_STANDALONE !== "false" ? "standalone" : undefined,
  pageExtensions: ["page.tsx", "page.ts"],
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["isomorphic-lib", "backend-lib"],
  eslint: {
    // already performed in CI, redundant
    ignoreDuringBuilds: true,
  },
  swcMinify: true,
  images: {
    domains: ["*"],
  },
  async headers() {
    return [
      {
        // Apply CORS headers to /dashboard/public path
        source: "/public/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/",
        destination: "/home",
        permanent: false,
      },
      {
        source: "/",
        destination: "/dashboard",
        basePath: false,
        permanent: false,
      },
    ];
  },
  experimental: {
    instrumentationHook: true,
    // MUI and date-fns are already optimized by Next; Remeda is not.
    optimizePackageImports: ["remeda"],
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },
};

module.exports = nextConfig;
