import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist 는 런타임에 워커(pdf.worker.mjs)를 동적 import 하므로
  // 서버 번들에 포함하지 말고 node_modules 에서 직접 로드하게 한다.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
