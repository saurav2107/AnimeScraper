/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ["better-sqlite3", "playwright-core", "sharp", "@huggingface/transformers", "onnxruntime-node"],
  reactStrictMode: true,
};
