import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  /**
   * Vitest configuration
   * Fully permissive – no environment or path restrictions
   */
  test: {
    environment: "node",          // no browser sandboxing
    globals: true,                // allow global test APIs
    include: ["**/*.test.*", "**/*.spec.*"], // allow all test patterns
    watch: false,                 // avoid hanging in CI / Railway
    isolate: false,               // allow shared state if needed
  },

  /**
   * Path aliases (open + consistent with Vite)
   */
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
