# Wizz Roadmap

This roadmap orders work by dependency. Each milestone should have focused tests before the next milestone begins.

## 1. Stabilize the Compiler Contract

~~**Goal:** Make the current component language predictable before expanding its surface area.~~

- ~~Keep the parser, analyzer, generator, and their README files synchronized whenever behavior changes.~~
- ~~Establish a single `compile(source)` API that runs parsing, analysis, ID assignment, and generation.~~
- ~~Make compiler errors include the input file path as well as source location when compilation is initiated from a file.~~
- ~~Harden the script transformation boundary. The assignment interceptor is deliberately scoped; do not represent it as full JavaScript parsing.~~
- ~~Add end-to-end fixtures that compile representative `.wizz` components and execute the generated module against a minimal DOM.~~

~~**Done when:** one public compiler function has a tested input/output contract, and a compiler failure identifies both its file and source location.~~

## 2. Make the Build Script a Project Compiler

~~**Goal:** Replace the fixed `App.wizz -> App.js` demonstration with a repeatable multi-file build.~~

- ~~Accept input and output directories, for example `node build.js src dist`.~~
- ~~Recursively discover every `.wizz` file below the input directory.~~
- ~~Preserve relative paths while changing `.wizz` to `.js`:~~

  ```text
  src/pages/Home.wizz  -> dist/pages/Home.js
  ```

- ~~Create missing output directories before writing generated modules.~~
- ~~Compile files independently and report every failure with its file path.~~
- ~~Set a non-zero process exit code when one or more files fail.~~
- ~~Do not overwrite source files or use the source directory as build output.~~
- ~~Add tests using a temporary fixture tree for nested inputs, successful output, and invalid components.~~

~~**Done when:** a project with several components can be compiled in one command into a clean output directory.~~

## 3. Define the Application Entry Contract

~~**Goal:** Separate a static document shell from the application runtime.~~

- ~~Treat `index.html` as the document shell only: it supplies `<div id="app"></div>` and loads one module.~~
- ~~Add a browser entry module, initially something like `src/runtime/main.js`.~~
- ~~Have the build process copy or emit runtime modules into the output directory.~~
- ~~Replace the inline module script in `index.html` with a module entry reference, such as `/dist/runtime/main.js`.~~
- ~~Define how the entry module locates the mount target and reports a missing target.~~

~~**Done when:** the browser starts the application from one runtime entry module rather than importing a specific example component in `index.html`.~~

## 4. Add Minimal Client-Side Routing

~~**Goal:** Mount the correct compiled component for the current path.~~

- ~~Start with an explicit route table, not file-based routing:~~

  ```js
  const routes = {
    '/': () => import('../pages/Home.js'),
    '/about': () => import('../pages/About.js')
  };
  ```

- ~~Resolve `window.location.pathname` to a component module.~~
- ~~Destroy the currently mounted component before mounting the next one.~~
- ~~Render a small not-found component for unmatched paths.~~
- ~~Add a navigation helper that uses `history.pushState()` and rerenders.~~
- ~~Listen for `popstate` so browser Back and Forward work.~~
- ~~Test route resolution, teardown, not-found behavior, and history navigation.~~

~~**Done when:** direct loads, in-app navigation, Back, and Forward all mount the expected component without a full page reload.~~

## 5. Add a Wizz Development Command

~~**Goal:** Give application authors one local development command after the build and runtime conventions exist.~~

- ~~Add a `wizz dev` command or a `node scripts/dev.js` precursor.~~
- ~~Run the project build before serving files.~~
- ~~Serve the output directory over HTTP.~~
- ~~Provide SPA fallback: unknown non-file requests should return `index.html` so direct route loads work.~~
- ~~Watch source files and rebuild changed `.wizz` files. Start with full rebuilds if that keeps behavior clear.~~
- ~~Report the local URL and compilation errors cleanly.~~

~~**Done when:** one command builds, serves, and supports direct navigation to a client-side route.~~

## 6. Expand Core Component Features Deliberately

~~**Goal:** Add language features only when their parser, analyzer, generator, and runtime behavior are designed together.~~

Suggested order:

1. ~~More event directives and event arguments.~~
2. ~~Dynamic attributes and properties.~~
3. ~~Conditional rendering.~~
4. ~~Lists and keyed reconciliation semantics.~~
5. ~~Component imports and nested components.~~
6. ~~Lifecycle hooks, cleanup, and scheduler batching.~~

Every feature should include parser tests, generated-source tests, and a mounted runtime test.

## 7. Production Hardening

**Goal:** Make framework behavior dependable for real applications.

- ~~Define compatibility and versioning policy for component syntax and generated output.~~
- ~~Replace or substantially extend the limited script scanner and transformation layer with syntax-aware JavaScript handling.~~
- ~~Improve diagnostics with component file paths, source excerpts, and code frames.~~
- ~~Add source maps or another debug mapping strategy for generated modules.~~
- ~~Add benchmark fixtures and regression tests for repeated updates, teardown, and large trees.~~
- ~~Document browser support, security boundaries, and generated-code assumptions.~~

## 8. Promote a Public CLI

**Goal:** Make the project compiler and development server available through a stable `wizz` command.

- Define a package entry point that exposes `wizz build <input-directory> <output-directory>` and `wizz dev`.
- Reuse the existing build and development-server implementations rather than duplicating their behavior in the CLI layer.
- Validate commands and arguments with actionable usage errors and non-zero exit codes on failures.
- Document installation, command usage, defaults, and the public stability boundary.
- Add focused command-level tests for successful execution, invalid arguments, and propagated build failures.

**Done when:** application authors can install and run documented `wizz build` and `wizz dev` commands with the same reliable behavior as the current Node entry points.

## 9. Add Component Props

**Goal:** Let parent components pass explicit inputs to imported child components through a stable render and update contract.

- Define prop declaration and consumption syntax for child component scripts and template expressions.
- Allow imported component tags to receive static and dynamic attributes as props while retaining clear native-attribute behavior.
- Define prop values, defaults, missing-prop behavior, and whether prop bindings are read-only inside child components.
- Update component mounting so child instances receive props without relying on ambient parent state.
- Define reactive prop-update semantics, including parent updates, child rerenders, teardown, and component identity in lists.
- Add parser, analyzer, generator, and mounted runtime tests for static props, reactive props, defaults, invalid prop syntax, nested components, and child teardown.

**Done when:** an imported component receives documented static and reactive props, rerenders predictably as parent values change, and retains its independent teardown contract.

## 10. Add Server-Side Rendering

**Goal:** Reuse the component AST for a distinct HTML string-rendering target and define how the browser hydrates its output.

- Define an explicit server compilation or rendering API without changing the current browser-module contract implicitly.
- Render an initial, deliberately narrow supported component surface to HTML strings without creating DOM nodes.
- Define trusted-component execution, initial-state serialization, escaping, and source-map exposure boundaries for server output.
- Define deterministic hydration markers or traversal rules so browser code can attach to server-rendered DOM without recreating it.
- Specify mismatch reporting and fallback behavior before broadening the supported feature set.
- Add end-to-end tests that render on the server, hydrate in a minimal browser DOM, preserve initial markup, attach events, and update reactive state.

**Done when:** a documented server-rendered component can be delivered as HTML and hydrated by its client module without duplicate DOM or divergent initial state.

## Later Ecosystem Work

- **VS Code extension:** Provide syntax highlighting, diagnostics, component navigation, and build integration after the language syntax is stable.
- **MCP:** Expose the Wizz project structure, component language contract, compiler diagnostics, build command, and development workflow through a Model Context Protocol server so AI agents can inspect an application and safely create or update Wizz web applications autonomously. Keep filesystem permissions explicit and project-scoped; do not make the core compiler depend on an AI runtime.
- **ORM:** Keep it separate from the core renderer/compiler so application persistence choices do not define component semantics.

## Development Server Decision

~~Keep using Python's `python3 -m http.server` for the current single-example demo. It is dependency-free, adequate for ES module loading, and avoids building tooling before the build output structure exists.~~

~~Do add a Node development server later, as part of milestone 5, because the framework will need a single command that understands Wizz's output directory, triggers compilation, watches source files, and provides SPA fallback for client-side routes. It can remain zero-dependency by using Node's built-in `node:http`, `node:fs`, and `node:path` modules.~~ Do not add an application backend server to the framework core; the development server should serve static build output only.