import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@price-tracker/extraction", "@price-tracker/db"],
  serverExternalPackages: ["@prisma/client", "prisma", "playwright"],
};

export default nextConfig;
