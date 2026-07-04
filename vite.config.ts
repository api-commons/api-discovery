import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// - nodePolyfills: the semantic/embedding stack pulls in Node built-ins (process, Buffer)
// - transformers is dynamically imported (semantic features are opt-in) so it lands
//   in its own lazy chunk; exclude from dep pre-bundling to avoid onnxruntime issues
export default defineConfig({
  plugins: [nodePolyfills({ globals: { process: true, Buffer: true } })],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['@xenova/transformers'] },
});
