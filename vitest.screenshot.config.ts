import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
export default defineConfig({plugins:[react()],test:{environment:'jsdom',setupFiles:['./tests/setup.screenshot.ts'],include:['scripts/screenshot/specs/**/*.spec.tsx'],globals:true,fileParallelism:false,testTimeout:60_000}});

