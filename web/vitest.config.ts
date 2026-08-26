import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Merged with the app's own vite config rather than written standalone, so any path alias
// or plugin the app relies on applies to tests too. A standalone config would resolve
// imports differently from the app it is testing, which is the same class of mistake as a
// check that re-derives an answer instead of asking the subsystem for it.
//
// VERIFIED BEFORE WRITING THIS: vite.config.ts default-exports a CONFIG OBJECT
// (`export default defineConfig({ ... })`), not the `defineConfig(({ mode }) => …)` function
// form. mergeConfig only accepts the object form — had it been a function this would fail at
// config load with a confusing error, and the fix would have been to call it first or to
// drop the merge and re-add every alias by hand. If vite.config.ts is ever converted to the
// function form, this file breaks and that is the reason.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,          // explicit imports; nothing appears by magic
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
}))
