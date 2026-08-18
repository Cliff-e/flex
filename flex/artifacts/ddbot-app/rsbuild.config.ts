import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';

const path = require('path');
const port = Number(process.env.PORT) || 5000;

// Resolve @deriv/deriv-charts to its actual install location.
// pnpm hoists packages to the workspace root, so we cannot use a relative
// './node_modules/...' path — use require.resolve to find it wherever pnpm put it.
const derivChartsDir = path.dirname(require.resolve('@deriv/deriv-charts/package.json'));

export default defineConfig({
    plugins: [
        pluginSass({
            sassLoaderOptions: {
                sourceMap: true,
                sassOptions: {},
            },
            exclude: /node_modules/,
        }),
        pluginReact(),
    ],
    source: {
        entry: {
            index: './src/main.tsx',
        },
        define: {
            'process.env': {
                TRANSLATIONS_CDN_URL: JSON.stringify(process.env.TRANSLATIONS_CDN_URL),
                R2_PROJECT_NAME: JSON.stringify(process.env.R2_PROJECT_NAME),
                CROWDIN_BRANCH_NAME: JSON.stringify(process.env.CROWDIN_BRANCH_NAME),
                TRACKJS_TOKEN: JSON.stringify(process.env.TRACKJS_TOKEN),
                APP_ENV: JSON.stringify(process.env.APP_ENV),
                REF_NAME: JSON.stringify(process.env.REF_NAME),
                REMOTE_CONFIG_URL: JSON.stringify(process.env.REMOTE_CONFIG_URL),
                GD_CLIENT_ID: JSON.stringify(process.env.GD_CLIENT_ID),
                GD_APP_ID: JSON.stringify(process.env.GD_APP_ID),
                GD_API_KEY: JSON.stringify(process.env.GD_API_KEY),
                DATADOG_SESSION_REPLAY_SAMPLE_RATE: JSON.stringify(process.env.DATADOG_SESSION_REPLAY_SAMPLE_RATE),
                DATADOG_SESSION_SAMPLE_RATE: JSON.stringify(process.env.DATADOG_SESSION_SAMPLE_RATE),
                DATADOG_APPLICATION_ID: JSON.stringify(process.env.DATADOG_APPLICATION_ID),
                DATADOG_CLIENT_TOKEN: JSON.stringify(process.env.DATADOG_CLIENT_TOKEN),
                RUDDERSTACK_KEY: JSON.stringify(process.env.RUDDERSTACK_KEY),
                GROWTHBOOK_CLIENT_KEY: JSON.stringify(process.env.GROWTHBOOK_CLIENT_KEY),
                GROWTHBOOK_DECRYPTION_KEY: JSON.stringify(process.env.GROWTHBOOK_DECRYPTION_KEY),
                VITE_API_URL: JSON.stringify(process.env.VITE_API_URL),
                VITE_DERIV_APP_ID: JSON.stringify(process.env.VITE_DERIV_APP_ID),
                VITE_API_BASE_URL: JSON.stringify(process.env.VITE_API_BASE_URL),
            },
        },
    },
    resolve: {
        alias: {
            // Force a single React 18 instance across all packages (including
            // @deriv-com/auth-client and other third-party deps). Using
            // require.resolve here resolves relative to __dirname (this config
            // file = ddbot-app root), so it always finds the local React 18.3.1
            // regardless of pnpm hoisting.
            'react': path.dirname(require.resolve('react/package.json')),
            'react-dom': path.dirname(require.resolve('react-dom/package.json')),
            '@/external': path.resolve(__dirname, './src/external'),
            '@/components': path.resolve(__dirname, './src/components'),
            '@/hooks': path.resolve(__dirname, './src/hooks'),
            '@/utils': path.resolve(__dirname, './src/utils'),
            '@/constants': path.resolve(__dirname, './src/constants'),
            '@/stores': path.resolve(__dirname, './src/stores'),
        },
    },
    output: {
        copy: [
            {
                // Use the absolute path resolved via require.resolve so this works
                // whether pnpm hoists the package to the workspace root or keeps it
                // under artifacts/ddbot-app/node_modules.
                from: path.join(derivChartsDir, 'dist/*'),
                to: 'js/smartcharts/[name][ext]',
                globOptions: {
                    ignore: ['**/*.LICENSE.txt'],
                },
            },
            {
                from: path.join(derivChartsDir, 'dist/chart/assets/*'),
                to: 'assets/[name][ext]',
            },
            {
                from: path.join(derivChartsDir, 'dist/chart/assets/fonts/*'),
                to: 'assets/fonts/[name][ext]',
            },
            {
                from: path.join(derivChartsDir, 'dist/chart/assets/shaders/*'),
                to: 'assets/shaders/[name][ext]',
            },
            { from: path.join(__dirname, 'public') },
        ],
        // Ensure service worker is not cached by the browser
        filename: {
            js: ({ chunk }) => {
                if (chunk?.name === 'sw') {
                    return '[name].js';
                }
                return '[name].[contenthash:8].js';
            },
        },
    },
    html: {
        template: './index.html',
    },
    server: {
        port,
        host: '0.0.0.0',
        compress: true,
        headers: {
            'Cross-Origin-Opener-Policy': 'unsafe-none',
            'Cross-Origin-Embedder-Policy': 'unsafe-none',
            'Cache-Control': 'no-cache',
        },
    },
    dev: {
        hmr: true,
    },
    tools: {
        rspack: {
            plugins: [],
            resolve: {},
            module: {
                rules: [
                    {
                        test: /\.xml$/,
                        exclude: /node_modules/,
                        use: 'raw-loader',
                    },
                ],
            },
        },
    },
});
