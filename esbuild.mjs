import esbuild from "esbuild"
import fs from "fs"
import module from "module"
import path from "path"

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'warning',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
	  jsdomPatch
    ]
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  // The sql.js WASM binary is loaded at runtime from the extension's dist dir.
  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  }
};

function parse(data) {
	data = data.toString("utf-8")
  
	//
	// Remove a possible UTF-8 BOM (byte order marker) as this can lead to parse
	// values when passed in to the JSON.parse.
	//
	if (data.charCodeAt(0) === 0xfeff) data = data.slice(1)
  
	try {
	  return JSON.parse(data)
	} catch (e) {
	  return false
	}
  }
  
  var iteratorSymbol =
	typeof Symbol === "function" && typeof Symbol.iterator === "symbol"
	  ? Symbol.iterator
	  : null
  
  function addSymbolIterator(result) {
	if (!iteratorSymbol) {
	  return result
	}
	result[iteratorSymbol] = function () {
	  return this
	}
	return result
  }
  
  function findPackageJson(root) {
	root = root || process.cwd()
	if (typeof root !== "string") {
	  if (typeof root === "object" && typeof root.filename === "string") {
		root = root.filename
	  } else {
		throw new Error(
		  "Must pass a filename string or a module object to finder"
		)
	  }
	}
	return addSymbolIterator({
	  /**
	   * Return the parsed package.json that we find in a parent folder.
	   *
	   * @returns {Object} Value, filename and indication if the iteration is done.
	   * @api public
	   */
	  next: function next() {
		if (root.match(/^(\w:\\|\/)$/))
		  return addSymbolIterator({
			value: undefined,
			filename: undefined,
			done: true,
		  })
  
		var file = path.join(root, "package.json"),
		  data
  
		root = path.resolve(root, "..")
  
		if (fs.existsSync(file) && (data = parse(fs.readFileSync(file)))) {
		  data.__path = file
  
		  return addSymbolIterator({
			value: data,
			filename: file,
			done: false,
		  })
		}
  
		return next()
	  },
	})
  }

const EXTENSIONS = {
	".js": "dynamic",
	".cjs": "dynamic",
	".mjs": "module",
	".es": "module",
	".es6": "module",
	".node": "addon",
	".json": "json",
	".wasm": "wasm",
}

async function requireResolve(specifier, parent, system) {
	try {
		// Let the default resolve algorithm try first
		let { url, format } = system(specifier, parent)

		// Resolve symlinks
		if (url.startsWith("file://")) {
			const realpath = await fs.promises.realpath(url.replace("file://", ""))
			url = `file://${realpath}`
		}

		return { url, format }
	} catch (error) {
		const base = parent
		? path.dirname(parent.replace("file://", ""))
		: process.cwd()
		const require = module.createRequire(path.join(base, specifier))

		let modulePath
		try {
			modulePath = require.resolve(specifier)
		} catch (e) {
			// .cjs is apparently not part of the default resolution algorithm,
			// so check if .cjs file exists before bailing completely
			modulePath = require.resolve(`${specifier}.cjs`)
		}

		const ext = path.extname(modulePath)

		let format = EXTENSIONS[ext] || "module"

		// Mimic default behavior of treating .js[x]? as ESM iff
		// relevant package.json contains { "type": "module" }
		if (!ext || [".js", ".jsx"].includes(ext)) {
			const dir = path.dirname(modulePath)
			const pkgdef = findPackageJson(dir).next()
			const type = pkgdef && pkgdef.value && pkgdef.value.type
			format = type === "module" ? "module" : "dynamic"
		}

		modulePath = await fs.promises.realpath(modulePath)

		return { url: `file://${path}`, format }
	}
}

const jsdomPatch = {
	name: "jsdom-patch",
	setup(build) {
	  build.onLoad({ filter: /XMLHttpRequest-impl\.js$/ }, async (args) => {
		let contents = await fs.promises.readFile(args.path, "utf8")
		console.log('args.path', args.path);
		contents = contents.replace(
		  'const syncWorkerFile = require.resolve ? require.resolve("./xhr-sync-worker.js") : null;',
		  `const syncWorkerFile = "${await requireResolve(
			"jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js"
		  )}";`.replaceAll("\\", process.platform === "win32" ? "\\\\" : "\\")
		)
		return { contents, loader: "js" }
	  })
	},
  }

main().catch(e => {
  console.error(e);
  process.exit(1);
});