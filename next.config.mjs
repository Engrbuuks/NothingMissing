/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Next tries to inline and minify remote font stylesheets at build time.
  // That needs network access during the build and fails noisily without it.
  // The <link> in layout.tsx loads them at runtime instead, which is fine.
  optimizeFonts: false,

  // These lived in the old static vercel.json. They belong here now: a
  // Next.js app applies them itself, and keeping a vercel.json around was
  // what kept overriding the build settings.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
    ];
  },

  async redirects() {
    return [
      { source: '/login', destination: '/sign-in', permanent: false },
      { source: '/signin', destination: '/sign-in', permanent: false },
    ];
  },
};

export default nextConfig;
