import { ResolvedConfig } from 'vite';
import glob from 'fast-glob';
import path, { basename } from 'path';
import { getOutput, getRoot, pathRelativeTo } from './utils';
import { build, BuildOptions, type Plugin } from 'esbuild';
import { VercelOutputIsr, ViteVercelApiEntry } from './types';
import { assert } from './assert';
import { vercelOutputVcConfigSchema } from './schemas/config/vc-config';
import fs, { copyFile } from 'fs/promises';
import type { Header, Rewrite } from '@vercel/routing-utils';
import { getNodeVersion } from '@vercel/build-utils';
import { nodeFileTrace } from '@vercel/nft';
import { findRoot } from '@manypkg/find-root';

export function getAdditionalEndpoints(resolvedConfig: ResolvedConfig) {
  return (resolvedConfig.vercel?.additionalEndpoints ?? []).map((e) => ({
    ...e,
    addRoute: e.addRoute ?? true,
    // path.resolve removes the trailing slash if any
    destination: path.posix.resolve('/', e.destination) + '.func',
  }));
}

export function getEntries(
  resolvedConfig: ResolvedConfig,
): ViteVercelApiEntry[] {
  const apiEntries = glob
    .sync(`${getRoot(resolvedConfig)}/api/**/*.*([a-zA-Z0-9])`)
    // from Vercel doc: Files with the underscore prefix are not turned into Serverless Functions.
    .filter((filepath) => !path.basename(filepath).startsWith('_'));

  if (apiEntries.length > 0) {
    console.warn(
      '@vercel/build is currently force building /api files itself, with no way to disable it. ' +
        'In order to avoid double compilation, you should temporarily rename /api to /_api while using this plugin. ' +
        '/_api functions are compiled under .vercel/output/functions/api/*.func as if they were in /api.',
    );
  }

  const otherApiEntries = glob
    .sync(`${getRoot(resolvedConfig)}/_api/**/*.*([a-zA-Z0-9])`)
    // from Vercel doc: Files with the underscore prefix are not turned into Serverless Functions.
    .filter((filepath) => !path.basename(filepath).startsWith('_'));

  return [...apiEntries, ...otherApiEntries].reduce((entryPoints, filePath) => {
    const outFilePath = pathRelativeTo(
      filePath,
      resolvedConfig,
      filePath.includes('/_api/') ? '_api' : 'api',
    );
    const parsed = path.posix.parse(outFilePath);

    entryPoints.push({
      source: filePath,
      destination: `api/${path.posix.join(parsed.dir, parsed.name)}.func`,
      addRoute: true,
    });

    return entryPoints;
  }, getAdditionalEndpoints(resolvedConfig));
}

const edgeWasmPlugin: Plugin = {
  name: 'edge-wasm-vercel',
  setup(build) {
    build.onResolve({ filter: /\.wasm/ }, (args) => {
      return {
        path: args.path.replace(/\.wasm\?module$/i, '.wasm'),
        external: true,
      };
    });
  },
};

const vercelOgPlugin = (ctx: { found: boolean; index: string }): Plugin => {
  return {
    name: 'vercel-og',
    setup(build) {
      build.onResolve({ filter: /@vercel\/og/ }, () => {
        ctx.found = true;
        return undefined;
      });

      build.onLoad({ filter: /@vercel\/og/ }, (args) => {
        ctx.index = args.path;
        return undefined;
      });
    },
  };
};

const standardBuildOptions: BuildOptions = {
  bundle: true,
  target: 'es2022',
  format: 'esm',
  platform: 'node',
  logLevel: 'info',
  logOverride: {
    'ignored-bare-import': 'verbose',
    'require-resolve-not-external': 'verbose',
  },
  minify: false,
  plugins: [],
};

export async function buildFn(
  resolvedConfig: ResolvedConfig,
  entry: ViteVercelApiEntry,
) {
  assert(
    entry.destination.length > 0,
    `Endpoint ${
      typeof entry.source === 'string' ? entry.source : '-'
    } does not have build destination`,
  );

  const options = Object.assign({}, standardBuildOptions);

  if (entry.buildOptions) {
    Object.assign(options, entry.buildOptions);
  }

  const filename =
    entry.edge || options.format === 'cjs' ? 'index.js' : 'index.mjs';
  const outfile = path.join(
    getOutput(resolvedConfig, 'functions'),
    entry.destination,
    filename,
  );

  Object.assign(options, { outfile });

  if (!options.stdin) {
    if (typeof entry.source === 'string') {
      options.entryPoints = [entry.source];
    } else {
      assert(
        typeof entry.source === 'object',
        `\`{ source }\` must be a string or an object`,
      );
      assert(
        typeof entry.source.contents === 'string',
        `\`{ contents }\` must be a string`,
      );
      options.stdin = entry.source;
    }
  }

  if (entry.edge) {
    options.conditions = [
      'edge-light',
      'browser',
      'module',
      'import',
      'require',
    ];
    options.plugins?.push(edgeWasmPlugin);
    options.format = 'esm';
  } else if (options.format === 'esm') {
    options.banner = {
      js: `import { createRequire as VPV_createRequire } from "node:module";
import { fileURLToPath as VPV_fileURLToPath } from "node:url";
import { dirname as VPV_dirname } from "node:path";
const require = VPV_createRequire(import.meta.url);
const __filename = VPV_fileURLToPath(import.meta.url);
const __dirname = VPV_dirname(__filename);
`,
    };
  }

  const ctx = { found: false, index: '' };
  options.plugins!.push(vercelOgPlugin(ctx));

  const output = await build(options);

  // guess some assets dependencies
  if (typeof entry.source == 'string') {
    let base = resolvedConfig.root;
    try {
      const dir = await findRoot(resolvedConfig.root);
      base = dir.rootDir;
    } catch (e) {
      // ignore error
    }
    const { fileList, reasons } = await nodeFileTrace([entry.source], {
      base,
      processCwd: resolvedConfig.root,
      mixedModules: true,
      ignore: [
        '**/node_modules/react{,-dom,-dom-server-turbopack}/**/*.development.js',
        '**/*.d.ts',
        '**/*.map',
        '**/node_modules/webpack5/**/*',
      ],
      async readFile(filepath) {
        if (filepath.endsWith('.ts') || filepath.endsWith('.tsx')) {
          const result = await build({
            ...standardBuildOptions,
            entryPoints: [entry.source as string],
            bundle: false,
            write: false,
          });

          return result.outputFiles[0].text;
        }

        return fs.readFile(filepath, 'utf-8');
      },
    });

    for (const file of fileList) {
      if (
        reasons.has(file) &&
        reasons.get(file)!.type.includes('asset') &&
        !file.endsWith('.js') &&
        !file.endsWith('.cjs') &&
        !file.endsWith('.mjs') &&
        !file.endsWith('package.json')
      ) {
        await copyFile(
          path.join(base, file),
          path.join(
            getOutput(resolvedConfig, 'functions'),
            entry.destination,
            basename(file),
          ),
        );
      }
    }
  }

  await writeVcConfig(resolvedConfig, entry.destination, filename, {
    edge: Boolean(entry.edge),
    streaming: entry.streaming,
  });

  return output;
}

export async function writeVcConfig(
  resolvedConfig: ResolvedConfig,
  destination: string,
  filename: string,
  options: {
    edge: boolean;
    streaming?: boolean;
  },
): Promise<void> {
  const vcConfig = path.join(
    getOutput(resolvedConfig, 'functions'),
    destination,
    '.vc-config.json',
  );

  const nodeVersion = await getNodeVersion(getOutput(resolvedConfig));

  await fs.writeFile(
    vcConfig,
    JSON.stringify(
      vercelOutputVcConfigSchema.parse(
        options.edge
          ? {
              runtime: 'edge',
              entrypoint: filename,
            }
          : {
              runtime: nodeVersion.runtime,
              handler: filename,
              maxDuration: resolvedConfig.vercel?.defaultMaxDuration,
              launcherType: 'Nodejs',
              shouldAddHelpers: true,
              supportsResponseStreaming:
                options.streaming ??
                resolvedConfig.vercel?.defaultSupportsResponseStreaming,
            },
      ),
      undefined,
      2,
    ),
    'utf-8',
  );
}

function getSourceAndDestination(destination: string) {
  if (destination.startsWith('api/')) {
    return path.posix.resolve('/', destination);
  }
  return path.posix.resolve('/', destination, ':match*');
}

const RE_BRACKETS = /^\[([^/]+)\]$/gm;
function replaceBrackets(source: string) {
  return source
    .split('/')
    .map((segment) => segment.replace(RE_BRACKETS, ':$1'))
    .join('/');
}

export async function buildEndpoints(resolvedConfig: ResolvedConfig): Promise<{
  rewrites: Rewrite[];
  isr: Record<string, VercelOutputIsr>;
  headers: Header[];
}> {
  const entries = getEntries(resolvedConfig);

  for (const entry of entries) {
    await buildFn(resolvedConfig, entry);
  }

  const isrEntries = entries
    .filter((e) => e.isr)
    .map(
      (e) =>
        [
          e.destination.replace(/\.func$/, ''),
          { expiration: e.isr!.expiration },
        ] as const,
    );

  return {
    rewrites: entries
      .filter((e) => e.addRoute !== false)
      .map((e) => e.destination.replace(/\.func$/, ''))
      .map((destination) => ({
        source: replaceBrackets(getSourceAndDestination(destination)),
        destination: getSourceAndDestination(destination),
      })),
    isr: Object.fromEntries(isrEntries),
    headers: entries
      .filter((e) => e.headers)
      .map((e) => ({
        source: '/' + e.destination.replace(/\.func$/, ''),
        headers: Object.entries(e.headers!).map(([key, value]) => ({
          key,
          value,
        })),
      })),
  };
}
