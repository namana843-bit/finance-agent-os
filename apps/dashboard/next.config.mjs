/** @type {import('next').NextConfig} */
const isPages = process.env.PAGES === "1" || process.env.GITHUB_ACTIONS === "true";
const nextConfig = {
  reactStrictMode: true,
  ...(isPages ? { output: "export", images: { unoptimized: true } } : {}),
  async rewrites() {
    if (isPages) return [];
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:4132/api/:path*",
      },
    ];
  },
};

export default nextConfig;
